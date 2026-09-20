"""
M13: Stale-data handling tests.
Verifies latest_orbital_elements view + state_model.py status logic
correctly classify fresh vs stale data.
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "logic"))

from state_model import STALE_THRESHOLD_HOURS, get_state


def connect():
    return psycopg2.connect(
        host="localhost",
        dbname="project_db",
        user="postgres",
        password="SpaceDB@2026",
    )


def test_view_is_stale_matches_threshold():
    """latest_orbital_elements.is_stale should be true iff fetched_at is older than 24hrs."""
    conn = connect()
    cur = conn.cursor()
    cur.execute(
        "SELECT object_id, fetched_at, is_stale FROM latest_orbital_elements;"
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()

    now = datetime.now(timezone.utc)
    mismatches = []
    for object_id, fetched_at, is_stale in rows:
        fetched_at = fetched_at.replace(tzinfo=timezone.utc)
        expected_stale = (now - fetched_at) > timedelta(hours=24)
        if expected_stale != is_stale:
            mismatches.append((object_id, fetched_at, is_stale, expected_stale))

    assert mismatches == [], f"Staleness mismatches found: {mismatches}"


def test_state_model_status_reflects_staleness():
    """state_model.get_state()'s status should be 'stale' if age_hours exceeds threshold, else 'fresh'."""
    conn = connect()
    cur = conn.cursor()
    cur.execute("SELECT object_id FROM orbital_elements LIMIT 1;")
    object_id = cur.fetchone()[0]
    cur.close()
    conn.close()

    state = get_state(object_id)

    if state["status"] == "fresh":
        assert state["age_hours"] <= STALE_THRESHOLD_HOURS
    elif state["status"] == "stale":
        assert state["age_hours"] > STALE_THRESHOLD_HOURS
    else:
        assert state["status"] in ("error", "unavailable"), f"Unexpected status: {state['status']}"


def test_state_model_unavailable_for_nonexistent_object():
    """Requesting state for an object_id with no orbital_elements should return 'unavailable', not crash."""
    state = get_state(999999999)
    assert state["status"] == "unavailable"
    assert state["position"] is None
