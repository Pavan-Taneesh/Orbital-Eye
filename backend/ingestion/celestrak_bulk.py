"""Idempotent bulk CelesTrak refresh.

Downloads (or reads from a local cache) the CelesTrak GP element feeds and the
SATCAT, then in ONE transaction:

* inserts a new ``orbital_elements`` row for every existing object whose GP
  epoch is newer than the latest stored epoch (values stored as-is: mean motion
  in rev/day, angles in degrees);
* upserts SATCAT facts into ``resolved_metadata`` (source CelesTrak);
* fills ``objects.cospar_id`` when null;
* with ``--expand``, also inserts on-orbit objects missing from ``objects``.

Usage:
    python -m ingestion.celestrak_bulk [--cache-dir DIR] [--offline] [--expand]

CelesTrak policy: a cached file younger than 2 hours is never re-downloaded.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import psycopg2
import requests
from dotenv import load_dotenv
from psycopg2.extras import execute_values

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CACHE_DIR = BACKEND_DIR / ".cache" / "celestrak"
SOURCE_ID = 1  # CelesTrak
MIN_REFETCH_SECONDS = 2 * 3600
BATCH = 2000
ADVISORY_LOCK_KEY = 7_424_001  # serialises concurrent ingest runs

GP_URL = "https://celestrak.org/NORAD/elements/gp.php?{query}&FORMAT=json"
SATCAT_URL = "https://celestrak.org/pub/satcat.csv"

# (cache file name, query, default category for payloads in that feed)
GP_FEEDS: list[tuple[str, str, int | None]] = [
    ("group-stations.json", "GROUP=stations", 1),
    ("group-gps-ops.json", "GROUP=gps-ops", 2),
    ("group-geo.json", "GROUP=geo", 3),
    ("group-weather.json", "GROUP=weather", 4),
    ("group-science.json", "GROUP=science", 5),
    ("group-active.json", "GROUP=active", None),
    ("rb.json", "NAME=R/B", 6),
    ("deb.json", "NAME=DEB", 7),
]
SATCAT_FILE = "satcat.csv"

# SATCAT column -> resolved_metadata field_name
SATCAT_FIELDS = {
    "OBJECT_TYPE": "object_type",
    "OPS_STATUS_CODE": "ops_status",
    "OWNER": "owner",
    "LAUNCH_DATE": "launch_date",
    "LAUNCH_SITE": "launch_site",
    "DECAY_DATE": "decay_date",
    "PERIOD": "period_min",
    "INCLINATION": "inclination_deg",
    "APOGEE": "apogee_km",
    "PERIGEE": "perigee_km",
    "RCS": "rcs_m2",
    "OBJECT_ID": "cospar_id",
}

OMM_COLUMNS = [
    "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE",
    "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT",
    "MEAN_MOTION_DDOT", "ELEMENT_SET_NO", "REV_AT_EPOCH",
]


def _fetch(url: str, dest: Path, offline: bool, log: list[str]) -> bool:
    """Ensure ``dest`` is populated. Returns True if the file is usable.

    Never raises on network/HTTP failure: an existing cache file is kept, and a
    ``<file>.fail`` stamp suppresses retries for MIN_REFETCH_SECONDS.
    """
    now = time.time()
    age = now - dest.stat().st_mtime if dest.exists() else None
    fail = dest.with_name(dest.name + ".fail")
    fail_age = now - fail.stat().st_mtime if fail.exists() else None
    if offline or (age is not None and age < MIN_REFETCH_SECONDS):
        if dest.exists():
            log.append(f"cache  {dest.name}")
            return True
        log.append(f"MISSING {dest.name} (offline)")
        return False
    if fail_age is not None and fail_age < MIN_REFETCH_SECONDS:
        log.append(f"skip   {dest.name} (recent failure; stale cache usable={dest.exists()})")
        return dest.exists()
    try:
        resp = requests.get(url, timeout=120, headers={"User-Agent": "orbital-eye-bulk/1.0"})
        ok = resp.status_code == 200 and bool(resp.content.strip())
        reason = f"HTTP {resp.status_code}"
    except requests.RequestException as exc:
        resp, ok, reason = None, False, type(exc).__name__
    if not ok or resp is None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        fail.touch()
        log.append(f"FAILED {dest.name}: {reason}; stale cache usable={dest.exists()}")
        return dest.exists()
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    tmp.write_bytes(resp.content)
    os.replace(tmp, dest)
    fail.unlink(missing_ok=True)
    log.append(f"fetch  {dest.name} ({len(resp.content) / 1e6:.1f} MB)")
    time.sleep(1.0)  # be polite between requests
    return True


def load_gp(cache_dir: Path, offline: bool, log: list[str]) -> dict[int, tuple[dict[str, Any], int | None]]:
    """Return {norad_id: (newest GP record, feed default category)}."""
    best: dict[int, tuple[dict[str, Any], int | None]] = {}
    for fname, query, cat in GP_FEEDS:
        path = cache_dir / fname
        if not _fetch(GP_URL.format(query=query), path, offline, log):
            continue
        try:
            records = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            log.append(f"BAD JSON {fname}")
            continue
        if not isinstance(records, list):
            log.append(f"UNEXPECTED payload in {fname}")
            continue
        for rec in records:
            try:
                norad = int(rec["NORAD_CAT_ID"])
                epoch = rec["EPOCH"]
            except (KeyError, TypeError, ValueError):
                continue
            prev = best.get(norad)
            if prev is None:
                best[norad] = (rec, cat)
            elif epoch > prev[0]["EPOCH"]:
                best[norad] = (rec, cat if cat is not None else prev[1])
            elif prev[1] is None and cat is not None:
                best[norad] = (prev[0], cat)
    return best


def load_satcat(cache_dir: Path, offline: bool, log: list[str]) -> dict[int, dict[str, str]]:
    path = cache_dir / SATCAT_FILE
    if not _fetch(SATCAT_URL, path, offline, log):
        return {}
    out: dict[int, dict[str, str]] = {}
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            try:
                out[int(row["NORAD_CAT_ID"])] = row
            except (KeyError, ValueError):
                continue
    return out


def _expand_category(satcat_row: dict[str, str] | None, feed_cat: int | None) -> int:
    otype = (satcat_row or {}).get("OBJECT_TYPE", "")
    if not otype and feed_cat in (6, 7):
        return feed_cat
    if otype == "R/B":
        return 6
    if otype == "DEB":
        return 7
    if otype == "PAY" and feed_cat is not None and feed_cat <= 5:
        return feed_cat
    return 5


def _counts(cur) -> dict[str, int]:
    cur.execute("SELECT count(*) FROM objects")
    objects = cur.fetchone()[0]
    cur.execute("SELECT count(DISTINCT object_id) FROM orbital_elements")
    with_el = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM resolved_metadata")
    rm = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM resolved_metadata WHERE field_name = 'decay_date'")
    decayed = cur.fetchone()[0]
    return {
        "objects": objects,
        "objects_with_elements": with_el,
        "resolved_metadata_rows": rm,
        "objects_decayed": decayed,
    }


def run(cache_dir: Path, offline: bool, expand: bool) -> dict[str, Any]:
    load_dotenv(dotenv_path=BACKEND_DIR.parent / ".env", override=False)
    cache_dir.mkdir(parents=True, exist_ok=True)
    log: list[str] = []
    gp = load_gp(cache_dir, offline, log)
    satcat = load_satcat(cache_dir, offline, log)
    for line in log:
        print(line)
    print(f"GP records: {len(gp)} unique objects; SATCAT rows: {len(satcat)}")

    conn = psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5432"),
        dbname=os.getenv("DB_NAME", "project_db"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD"),
    )
    try:
        with conn, conn.cursor() as cur:  # one transaction
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (ADVISORY_LOCK_KEY,))
            before = _counts(cur)

            cur.execute("SELECT norad_id, object_id, cospar_id FROM objects WHERE norad_id IS NOT NULL")
            existing = {n: (oid, cos) for n, oid, cos in cur.fetchall()}

            created = 0
            if expand:
                new_rows = []
                for norad, (rec, feed_cat) in gp.items():
                    if norad in existing:
                        continue
                    sc = satcat.get(norad)
                    if sc is not None and sc.get("DECAY_DATE"):
                        continue  # re-entered, not on orbit
                    cat = _expand_category(sc, feed_cat)
                    new_rows.append((rec["OBJECT_NAME"], norad, rec.get("OBJECT_ID"), cat))
                if new_rows:
                    inserted = execute_values(
                        cur,
                        "INSERT INTO objects (name, norad_id, cospar_id, category_id) VALUES %s "
                        "ON CONFLICT DO NOTHING RETURNING object_id",
                        new_rows, page_size=BATCH, fetch=True,
                    )
                    created = len(inserted)
                    cur.execute("SELECT norad_id, object_id, cospar_id FROM objects WHERE norad_id IS NOT NULL")
                    existing = {n: (oid, cos) for n, oid, cos in cur.fetchall()}

            # --- orbital elements: only strictly newer epochs ---
            cur.execute("SELECT object_id, max(epoch) FROM orbital_elements GROUP BY object_id")
            latest = dict(cur.fetchall())
            el_rows = []
            for norad, (rec, _cat) in gp.items():
                if norad not in existing:
                    continue
                oid = existing[norad][0]
                try:
                    ep = datetime.fromisoformat(rec["EPOCH"])
                except ValueError:
                    continue
                if oid in latest and ep <= latest[oid]:
                    continue
                if any(rec.get(c) is None for c in OMM_COLUMNS):
                    continue
                el_rows.append((oid, SOURCE_ID, ep, *(rec[c] for c in OMM_COLUMNS)))
            if el_rows:
                execute_values(
                    cur,
                    "INSERT INTO orbital_elements (object_id, source_id, epoch, mean_motion, eccentricity, "
                    "inclination, ra_of_asc_node, arg_of_pericenter, mean_anomaly, bstar, mean_motion_dot, "
                    "mean_motion_ddot, element_set_no, rev_at_epoch) VALUES %s",
                    el_rows, page_size=BATCH,
                )

            # --- SATCAT -> resolved_metadata, objects.cospar_id ---
            rm_rows = []
            cospar_fill = []
            for norad, (oid, cos) in existing.items():
                row = satcat.get(norad)
                if not row:
                    continue
                for col, field in SATCAT_FIELDS.items():
                    val = (row.get(col) or "").strip()
                    if val:  # blank fields (and unset decay_date) are skipped
                        rm_rows.append((oid, field, val, SOURCE_ID))
                if cos is None and (row.get("OBJECT_ID") or "").strip():
                    cospar_fill.append((oid, row["OBJECT_ID"].strip()))
            if rm_rows:
                execute_values(
                    cur,
                    "INSERT INTO resolved_metadata (object_id, field_name, field_value, source_id) VALUES %s "
                    "ON CONFLICT (object_id, field_name) DO UPDATE SET field_value = EXCLUDED.field_value, "
                    "source_id = EXCLUDED.source_id, resolved_at = NOW() "
                    "WHERE resolved_metadata.field_value IS DISTINCT FROM EXCLUDED.field_value",
                    rm_rows, page_size=BATCH,
                )
            cospar_set = 0
            if cospar_fill:
                cur.execute("SELECT cospar_id FROM objects WHERE cospar_id IS NOT NULL")
                taken = {r[0] for r in cur.fetchall()}
                fill = []
                for oid, cid in cospar_fill:
                    if cid not in taken:
                        taken.add(cid)
                        fill.append((oid, cid))
                if fill:
                    execute_values(
                        cur,
                        "UPDATE objects o SET cospar_id = v.cid, updated_at = NOW() "
                        "FROM (VALUES %s) AS v(oid, cid) WHERE o.object_id = v.oid AND o.cospar_id IS NULL",
                        fill, page_size=BATCH,
                    )
                    cospar_set = len(fill)
            after = _counts(cur)
    finally:
        conn.close()

    summary = {
        "before": before,
        "after": after,
        "new_objects_created": created,
        "element_rows_inserted": len(el_rows),
        "resolved_metadata_candidates": len(rm_rows),
        "cospar_filled": cospar_set,
    }
    print(json.dumps(summary, indent=2))
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    ap.add_argument("--offline", action="store_true", help="use cached files only, never download")
    ap.add_argument("--expand", action="store_true", help="insert on-orbit objects missing from `objects`")
    args = ap.parse_args(argv)
    run(args.cache_dir, args.offline, args.expand)
    return 0


if __name__ == "__main__":
    sys.exit(main())
