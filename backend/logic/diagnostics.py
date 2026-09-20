"""
Diagnostics data (P2-M12).
Dev-only debug values for Person 3's diagnostics UI: raw orbital_elements,
SGP4 error code, staleness details, full ingestion history for an object.

Usage (standalone test):
    python logic/diagnostics.py <object_id>
"""

import os
from datetime import datetime, timezone

import psycopg2
from propagate import build_satellite, get_latest_elements
from sgp4.api import jday

STALE_THRESHOLD_HOURS = 24


def connect():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        dbname=os.getenv("DB_NAME", "project_db"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD"),
    )


def get_raw_latest_row(object_id: int):
    """Full raw orbital_elements row (all columns) for the latest entry."""
    conn = connect()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT element_id, object_id, source_id, epoch, mean_motion, eccentricity,
               inclination, ra_of_asc_node, arg_of_pericenter, mean_anomaly, bstar,
               mean_motion_dot, mean_motion_ddot, element_set_no, rev_at_epoch, fetched_at
        FROM orbital_elements
        WHERE object_id = %s
        ORDER BY fetched_at DESC
        LIMIT 1;
        """,
        (object_id,),
    )
    row = cur.fetchone()
    colnames = [desc[0] for desc in cur.description]
    cur.close()
    conn.close()
    if row is None:
        return None
    return dict(zip(colnames, row))


def get_ingestion_history(object_id: int):
    """All orbital_elements rows ever fetched for this object, oldest to newest."""
    conn = connect()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT element_id, source_id, epoch, fetched_at
        FROM orbital_elements
        WHERE object_id = %s
        ORDER BY fetched_at ASC;
        """,
        (object_id,),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return [
        {"element_id": r[0], "source_id": r[1], "epoch": r[2].isoformat(), "fetched_at": r[3].isoformat()}
        for r in rows
    ]


def get_sgp4_error_code(object_id: int, when: datetime = None):
    """Run SGP4 directly and return raw error code (0 = success)."""
    if when is None:
        when = datetime.now(timezone.utc)

    select_row = (
        "epoch", "mean_motion", "eccentricity", "inclination",
        "ra_of_asc_node", "arg_of_pericenter", "mean_anomaly",
        "bstar", "mean_motion_dot", "mean_motion_ddot",
    )
    row = get_latest_elements(object_id)
    sat = build_satellite(row)

    jd, fr = jday(when.year, when.month, when.day,
                   when.hour, when.minute, when.second + when.microsecond / 1e6)
    error, position, velocity = sat.sgp4(jd, fr)
    return error


def get_diagnostics(object_id: int):
    """Full diagnostics bundle for one object."""
    raw_row = get_raw_latest_row(object_id)

    if raw_row is None:
        return {
            "object_id": object_id,
            "raw_latest_row": None,
            "sgp4_error_code": None,
            "staleness": None,
            "ingestion_history": [],
        }

    now = datetime.now(timezone.utc)
    fetched_at = raw_row["fetched_at"].replace(tzinfo=timezone.utc)
    age_hours = (now - fetched_at).total_seconds() / 3600.0

    sgp4_error_code = get_sgp4_error_code(object_id, now)
    history = get_ingestion_history(object_id)

    return {
        "object_id": object_id,
        "raw_latest_row": {
            k: (v.isoformat() if hasattr(v, "isoformat") else v)
            for k, v in raw_row.items()
        },
        "sgp4_error_code": sgp4_error_code,
        "staleness": {
            "age_hours": round(age_hours, 2),
            "threshold_hours": STALE_THRESHOLD_HOURS,
            "is_stale": age_hours > STALE_THRESHOLD_HOURS,
        },
        "ingestion_history": history,
        "ingestion_row_count": len(history),
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python logic/diagnostics.py <object_id>")
        sys.exit(1)

    object_id = int(sys.argv[1])
    diag = get_diagnostics(object_id)

    import json
    print(json.dumps(diag, indent=2, default=str))
