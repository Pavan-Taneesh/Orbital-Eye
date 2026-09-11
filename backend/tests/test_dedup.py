"""
M13: Dedup / matching logic tests.
Verifies norad_id UNIQUE constraint holds and cross-source matching
doesn't produce duplicate objects.
"""

import sys
from pathlib import Path

import psycopg2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "logic"))


def connect():
    return psycopg2.connect(
        host="localhost",
        dbname="project_db",
        user="postgres",
        password="SpaceDB@2026",
    )


def test_no_duplicate_norad_ids_in_objects():
    """objects.norad_id should be unique — no two rows share the same norad_id."""
    conn = connect()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT norad_id, COUNT(*) 
        FROM objects 
        GROUP BY norad_id 
        HAVING COUNT(*) > 1;
        """
    )
    duplicates = cur.fetchall()
    cur.close()
    conn.close()

    assert duplicates == [], f"Found duplicate norad_ids: {duplicates}"


def test_unique_constraint_rejects_duplicate_insert():
    """Attempting to insert a norad_id that already exists should fail (DB-level enforcement)."""
    conn = connect()
    cur = conn.cursor()

    cur.execute("SELECT norad_id FROM objects LIMIT 1;")
    existing_norad_id = cur.fetchone()[0]

    with pytest.raises(psycopg2.errors.UniqueViolation):
        cur.execute(
            "INSERT INTO objects (name, norad_id) VALUES (%s, %s);",
            ("TEST_DUPLICATE_OBJECT", existing_norad_id),
        )
        conn.commit()

    conn.rollback()  # required after a failed insert, or connection stays broken
    cur.close()
    conn.close()


def test_object_count_matches_expected_minimum():
    """Sanity check: total object count should be at least the sum of known CelesTrak category counts."""
    conn = connect()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM objects;")
    count = cur.fetchone()[0]
    cur.close()
    conn.close()

    # From CelesTrak confirmed counts: 22+32+568+52+47+6848+2646 = 10215 minimum
    assert count >= 10215, f"Object count lower than expected minimum: {count}"
