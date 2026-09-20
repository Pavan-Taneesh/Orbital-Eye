"""
Scientific-state model (Contract C).
Wraps propagate.py output into the fixed shape Person 1 reads:
position, velocity, altitude, epoch, frame, source, age, status.

Usage (standalone test):
    python logic/state_model.py <object_id>
"""

import os
import sys
from datetime import datetime, timezone

import psycopg2
from propagate import build_satellite, get_latest_elements, propagate

SOURCE_NAMES = {
    1: "CelesTrak",
    2: "Space-Track",
    3: "SatNOGS",
    4: "ESA DISCOS",
}

STALE_THRESHOLD_HOURS = 24


def connect():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        dbname=os.getenv("DB_NAME", "project_db"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD"),
    )


def get_source_and_freshness(object_id: int):
    """Pull source_id and fetched_at for the latest orbital_elements row."""
    conn = connect()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT source_id, fetched_at
        FROM orbital_elements
        WHERE object_id = %s
        ORDER BY fetched_at DESC
        LIMIT 1;
        """,
        (object_id,),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None:
        return None, None
    return row


def get_state(object_id: int, when: datetime | None = None):
    """
    Build the Contract C state dict for one object.
    `when` defaults to now (UTC) if not given.
    """
    if when is None:
        when = datetime.now(timezone.utc)

    source_id, fetched_at = get_source_and_freshness(object_id)

    if source_id is None:
        return {
            "object_id": object_id,
            "position": None,
            "velocity": None,
            "altitude": None,
            "epoch": None,
            "frame": "ECEF",
            "source": None,
            "age_hours": None,
            "status": "unavailable",
        }

    row = get_latest_elements(object_id)
    epoch = row[0]  # first column in propagate.py's SELECT
    sat = build_satellite(row)

    try:
        position, velocity, altitude = propagate(sat, when)
        propagation_ok = True
    except RuntimeError:
        position, velocity, altitude = None, None, None
        propagation_ok = False

    age_hours = (when - fetched_at.replace(tzinfo=timezone.utc)).total_seconds() / 3600.0

    if not propagation_ok:
        status = "error"
    elif age_hours > STALE_THRESHOLD_HOURS:
        status = "stale"
    else:
        status = "fresh"

    return {
        "object_id": object_id,
        "position": position,
        "velocity": velocity,
        "altitude": altitude,
        "epoch": epoch.isoformat(),
        "frame": "ECEF",  # SGP4 native output frame — not pure ECI, flagged for Person 1
        "source": SOURCE_NAMES.get(source_id, f"unknown({source_id})"),
        "age_hours": round(age_hours, 2),
        "status": status,
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python logic/state_model.py <object_id>")
        sys.exit(1)

    object_id = int(sys.argv[1])
    state = get_state(object_id)

    for k, v in state.items():
        print(f"{k}: {v}")
