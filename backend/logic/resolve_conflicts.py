import os

import psycopg2


def connect():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        dbname=os.getenv("DB_NAME", "project_db"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD"),
    )


# source_id reference (from seed.sql): 1=CelesTrak, 2=Space-Track, 3=SatNOGS, 4=ESA DISCOS

# Priority lists per field — first in list wins
FIELD_PRIORITY = {
    "launch_date":   [4, 2, 3],   # DISCOS, Space-Track, SatNOGS
    "operator":      [4, 2, 3],
    "manufacturer":  [4, 2, 3],
    "mass":          [4, 2, 3],
    "image_url":     [3, 4],      # SatNOGS, DISCOS
}
DEFAULT_PRIORITY: list[int] = []  # empty = fall back to confidence + recency


def resolve_conflicts():
    conn = connect()
    cur = conn.cursor()

    # --- Pull all metadata rows ---
    cur.execute("SELECT object_id, source_id, field_name, field_value, confidence, recorded_at FROM metadata;")
    rows = cur.fetchall()

    # --- Group by (object_id, field_name) ---
    groups = {}
    for object_id, source_id, field_name, field_value, confidence, recorded_at in rows:
        key = (object_id, field_name)
        groups.setdefault(key, []).append({
            "source_id": source_id,
            "field_value": field_value,
            "confidence": confidence,
            "recorded_at": recorded_at
        })

    # --- Resolve winner per group ---
    resolved = 0
    for (object_id, field_name), candidates in groups.items():
        priority = FIELD_PRIORITY.get(field_name, DEFAULT_PRIORITY)

        if priority:
            # pick first candidate whose source_id appears earliest in priority list
            winner = None
            for src in priority:
                match = next((c for c in candidates if c["source_id"] == src), None)
                if match:
                    winner = match
                    break
            if winner is None:
                winner = max(candidates, key=lambda c: (c["confidence"], c["recorded_at"]))
        else:
            # fallback: highest confidence, then most recent
            winner = max(candidates, key=lambda c: (c["confidence"], c["recorded_at"]))

        cur.execute("""
            INSERT INTO resolved_metadata (object_id, field_name, field_value, source_id)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (object_id, field_name)
            DO UPDATE SET field_value = EXCLUDED.field_value,
                          source_id = EXCLUDED.source_id,
                          resolved_at = NOW();
        """, (object_id, field_name, winner["field_value"], winner["source_id"]))
        resolved += 1

    conn.commit()
    print(f"Resolved {resolved} object+field combinations.")

    cur.close()
    conn.close()


if __name__ == "__main__":
    resolve_conflicts()
