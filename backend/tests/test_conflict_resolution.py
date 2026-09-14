"""
M13: Conflict resolution tests.
Verifies resolved_metadata respects FIELD_PRIORITY ordering and
upsert behavior (no duplicate object_id+field_name rows).
"""

import sys
from pathlib import Path

import psycopg2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "logic"))


def connect():
    return psycopg2.connect(
        host="localhost",
        dbname="project_db",
        user="postgres",
        password="SpaceDB@2026",
    )


def test_no_duplicate_resolved_metadata_rows():
    """resolved_metadata should have exactly one row per (object_id, field_name)."""
    conn = connect()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT object_id, field_name, COUNT(*)
        FROM resolved_metadata
        GROUP BY object_id, field_name
        HAVING COUNT(*) > 1;
        """
    )
    duplicates = cur.fetchall()
    cur.close()
    conn.close()

    assert duplicates == [], f"Found duplicate resolved_metadata rows: {duplicates}"


def test_priority_fields_prefer_discos_over_spacetrack():
    """
    For fields in FIELD_PRIORITY (e.g. operator: DISCOS(4) > Space-Track(2) > SatNOGS(3)),
    if both DISCOS and Space-Track have a value for the same object+field,
    resolved_metadata should hold the DISCOS value, not Space-Track's.
    """
    conn = connect()
    cur = conn.cursor()

    # find an object+field where both source_id 4 (DISCOS) and source_id 2 (Space-Track)
    # have competing metadata for a priority field like 'operator'
    cur.execute(
        """
        SELECT m4.object_id, m4.field_value AS discos_value, m2.field_value AS spacetrack_value
        FROM metadata m4
        JOIN metadata m2
          ON m4.object_id = m2.object_id AND m4.field_name = m2.field_name
        WHERE m4.source_id = 4 AND m2.source_id = 2
          AND m4.field_name = 'operator'
        LIMIT 1;
        """
    )
    row = cur.fetchone()

    if row is None:
        cur.close()
        conn.close()
        import pytest
        pytest.skip("No object has competing DISCOS+Space-Track 'operator' values to test priority against")

    object_id, discos_value, _ = row

    cur.execute(
        """
        SELECT field_value FROM resolved_metadata
        WHERE object_id = %s AND field_name = 'operator';
        """,
        (object_id,),
    )
    resolved = cur.fetchone()
    cur.close()
    conn.close()

    assert resolved is not None, f"No resolved_metadata row for object_id={object_id}, field 'operator'"
    assert resolved[0] == discos_value, (
        f"Expected DISCOS value '{discos_value}' to win priority, got '{resolved[0]}'"
    )


def test_resolved_metadata_has_no_none_string_values():
    """Regression test for the SatNOGS 'None' string bug — should never resurface in resolved_metadata."""
    conn = connect()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT COUNT(*) FROM resolved_metadata
        WHERE LOWER(field_value) = 'none';
        """
    )
    count = cur.fetchone()[0]
    cur.close()
    conn.close()

    assert count == 0, f"Found {count} resolved_metadata rows with literal 'None' string value"
