"""Catalog service: one cached snapshot of every on-orbit object.

Backs ``GET /api/v1/catalog``. The frontend downloads this once and propagates
positions client-side, so the payload carries the latest SGP4 mean elements
(CelesTrak OMM field names/units) plus a little SATCAT metadata per object.

The serialized JSON bytes are cached in-process. A cheap "version" query
(count + max timestamps) is re-run at most once per ``VERSION_TTL_S`` seconds;
the full catalog is rebuilt only when that version changes.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import math
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from db import get_connection as connect

VERSION_TTL_S = 60.0
ERROR_BACKOFF_S = 10.0
GZIP_LEVEL = 9

logger = logging.getLogger(__name__)


class CatalogUnavailableError(RuntimeError):
    """No snapshot exists and the database cannot be reached."""

_TYPE_MAP = {"PAY": "PAY", "R/B": "R/B", "DEB": "DEB"}

# Latest element row per object (DISTINCT ON), resolved_metadata pivoted with
# conditional aggregation. Re-entered objects (decay_date set) are excluded.
CATALOG_SQL = """
WITH latest AS (
    SELECT DISTINCT ON (object_id)
           object_id, epoch, mean_motion, eccentricity, inclination,
           ra_of_asc_node, arg_of_pericenter, mean_anomaly, bstar,
           mean_motion_dot, mean_motion_ddot
    FROM orbital_elements
    WHERE mean_motion IS NOT NULL AND eccentricity IS NOT NULL
      AND inclination IS NOT NULL AND ra_of_asc_node IS NOT NULL
      AND arg_of_pericenter IS NOT NULL AND mean_anomaly IS NOT NULL
      AND mean_motion > 0 AND eccentricity >= 0 AND eccentricity < 1
    ORDER BY object_id, epoch DESC, element_id DESC
),
meta AS (
    SELECT object_id,
           max(field_value) FILTER (WHERE field_name = 'object_type')  AS object_type,
           max(field_value) FILTER (WHERE field_name = 'owner')        AS owner,
           max(field_value) FILTER (WHERE field_name = 'launch_date')  AS launch_date,
           max(field_value) FILTER (WHERE field_name = 'launch_site')  AS launch_site,
           max(field_value) FILTER (WHERE field_name = 'rcs_m2')       AS rcs_m2,
           max(field_value) FILTER (WHERE field_name = 'decay_date')   AS decay_date
    FROM resolved_metadata
    GROUP BY object_id
)
SELECT o.object_id, o.norad_id, o.name, o.cospar_id, o.category_id,
       m.object_type, m.owner, m.launch_date, m.launch_site, m.rcs_m2,
       l.epoch, l.mean_motion, l.eccentricity, l.inclination, l.ra_of_asc_node,
       l.arg_of_pericenter, l.mean_anomaly, l.bstar, l.mean_motion_dot,
       l.mean_motion_ddot
FROM objects o
JOIN latest l ON l.object_id = o.object_id
LEFT JOIN meta m ON m.object_id = o.object_id
WHERE o.norad_id IS NOT NULL
  AND (m.decay_date IS NULL OR m.decay_date = '')
ORDER BY o.object_id;
"""

VERSION_SQL = """
SELECT (SELECT count(*) FROM orbital_elements),
       (SELECT max(fetched_at) FROM orbital_elements),
       (SELECT max(resolved_at) FROM resolved_metadata);
"""

COUNTS_SQL = """
SELECT (SELECT count(*) FROM objects),
       (SELECT count(DISTINCT object_id) FROM resolved_metadata
         WHERE field_name = 'decay_date' AND field_value <> '');
"""


@dataclass(frozen=True)
class CatalogSnapshot:
    version: str
    body: bytes  # serialized CatalogResponseWire JSON
    gz_body: bytes  # same JSON, gzip-compressed once (mtime=0, deterministic)


_lock = threading.Lock()
_snapshot: CatalogSnapshot | None = None
_version_checked_at = 0.0


def _compute_version(cur) -> str:
    cur.execute(VERSION_SQL)
    count, max_fetched, max_resolved = cur.fetchone()
    raw = f"{count}|{max_fetched.isoformat() if max_fetched else ''}|{max_resolved.isoformat() if max_resolved else ''}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _build_entry(row: tuple) -> dict[str, Any]:
    (object_id, norad, name, cospar, cat, otype, owner, launch, site, rcs,
     epoch, mm, ecc, inc, raan, argp, ma, bstar, mmdot, mmddot) = row
    return {
        "id": object_id,
        "norad": norad,
        "name": name,
        "cospar": cospar,
        "cat": cat,
        "type": _TYPE_MAP.get(otype or "", "UNK"),
        "owner": owner or None,
        "launch": launch or None,
        "site": site or None,
        "rcs": _to_float(rcs),
        "omm": {
            "EPOCH": epoch.isoformat(),
            "MEAN_MOTION": float(mm),
            "ECCENTRICITY": float(ecc),
            "INCLINATION": float(inc),
            "RA_OF_ASC_NODE": float(raan),
            "ARG_OF_PERICENTER": float(argp),
            "MEAN_ANOMALY": float(ma),
            "BSTAR": float(bstar or 0.0),
            "MEAN_MOTION_DOT": float(mmdot or 0.0),
            "MEAN_MOTION_DDOT": float(mmddot or 0.0),
        },
    }


def _build_snapshot(cur, version: str) -> CatalogSnapshot:
    cur.execute(CATALOG_SQL)
    objects = [_build_entry(r) for r in cur.fetchall()]
    cur.execute(COUNTS_SQL)
    total, decayed = cur.fetchone()
    payload = {
        "version": version,
        "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "total_objects": total,
        "decayed_objects": decayed,
        "objects": objects,
    }
    body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
    gz_body = gzip.compress(body, compresslevel=GZIP_LEVEL, mtime=0)
    return CatalogSnapshot(version=version, body=body, gz_body=gz_body)


def get_catalog_snapshot(*, force_check: bool = False) -> CatalogSnapshot:
    """Return the cached snapshot, rebuilding it only if the data changed.

    If the database errors and a snapshot exists, the stale snapshot is served
    and the version check is retried after ERROR_BACKOFF_S. Raises
    CatalogUnavailableError when there is no snapshot to fall back on.
    """
    global _snapshot, _version_checked_at
    now = time.monotonic()
    snap = _snapshot
    if snap is not None and not force_check and now - _version_checked_at < VERSION_TTL_S:
        return snap
    with _lock:
        now = time.monotonic()
        snap = _snapshot
        if snap is not None and not force_check and now - _version_checked_at < VERSION_TTL_S:
            return snap
        try:
            conn = connect()
            try:
                # One consistent read view for version + body so they can't disagree.
                conn.set_session(isolation_level="REPEATABLE READ", readonly=True)
                with conn.cursor() as cur:
                    version = _compute_version(cur)
                    if snap is None or snap.version != version:
                        snap = _build_snapshot(cur, version)
            finally:
                conn.close()
        except Exception as exc:
            logger.warning("catalog refresh failed: %s", type(exc).__name__)
            if _snapshot is None:
                raise CatalogUnavailableError("catalog unavailable") from exc
            # Back off: retry the version check in ~ERROR_BACKOFF_S.
            _version_checked_at = time.monotonic() - VERSION_TTL_S + ERROR_BACKOFF_S
            return _snapshot
        _snapshot = snap
        _version_checked_at = time.monotonic()
        return snap


def reset_cache() -> None:
    """Drop the in-process cache (tests)."""
    global _snapshot, _version_checked_at
    with _lock:
        _snapshot = None
        _version_checked_at = 0.0
