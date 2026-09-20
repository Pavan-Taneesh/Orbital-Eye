from pathlib import Path

from dotenv import load_dotenv

env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path, override=True)

import os

import psycopg2
import requests

SOURCE_ID = 3  # SatNOGS
API_URL = "https://db.satnogs.org/api/satellites/?format=json"

conn = psycopg2.connect(
    host=os.getenv("DB_HOST", "localhost"),
    dbname=os.getenv("DB_NAME", "project_db"),
    user=os.getenv("DB_USER", "postgres"),
    password=os.getenv("DB_PASSWORD", ""),
)
cur = conn.cursor()

# --- Build norad_id -> object_id lookup from DB (all categories) ---
cur.execute("SELECT object_id, norad_id FROM objects WHERE norad_id IS NOT NULL;")
norad_to_object = {row[1]: row[0] for row in cur.fetchall()}
print(f"{len(norad_to_object)} objects in DB to match against SatNOGS")

# --- Fetch SatNOGS satellites, handle pagination (DRF-style) or plain list ---
all_records = []
url = API_URL

while url:
    response = requests.get(url, timeout=30)
    if response.status_code != 200 or not response.text.strip():
        print(f"SatNOGS fetch failed: status {response.status_code}")
        break

    payload = response.json()

    if isinstance(payload, dict) and "results" in payload:
        all_records.extend(payload["results"])
        url = payload.get("next")
    else:
        # plain list, no pagination wrapper
        all_records.extend(payload)
        url = None

print(f"Fetched {len(all_records)} satellite records from SatNOGS")

matched = 0
metadata_rows = 0
media_rows = 0
identifier_rows = 0

for sat in all_records:
    norad_id = sat.get("norad_cat_id")
    if norad_id is None or norad_id not in norad_to_object:
        continue

    object_id = norad_to_object[norad_id]
    matched += 1

    # --- metadata: one row per field, only if value present ---
    field_map = {
        "status": sat.get("status"),
        "operator": sat.get("operator"),
        "countries": sat.get("countries"),
        "launch_date": sat.get("launched"),
        "decay_date": sat.get("decayed"),
    }

    for field_name, field_value in field_map.items():
        if field_value and str(field_value).strip().lower() != "none":
            cur.execute("""
                INSERT INTO metadata (object_id, source_id, field_name, field_value)
                VALUES (%s, %s, %s, %s);
            """, (object_id, SOURCE_ID, field_name, str(field_value)))
            metadata_rows += 1

    # --- media: image URL, if present ---
    image_url = sat.get("image")
    if image_url:
        cur.execute("""
            INSERT INTO media (object_id, url, media_type, source_id)
            VALUES (%s, %s, %s, %s);
        """, (object_id, image_url, "image", SOURCE_ID))
        media_rows += 1

    # --- identifiers: SatNOGS sat_id, for cross-source matching later ---
    sat_id = sat.get("sat_id")
    if sat_id:
        cur.execute("""
            INSERT INTO identifiers (object_id, source_id, external_id)
            VALUES (%s, %s, %s)
            ON CONFLICT (source_id, external_id) DO NOTHING;
        """, (object_id, SOURCE_ID, sat_id))
        identifier_rows += 1

conn.commit()

print(f"Matched: {matched} objects")
print(f"Inserted: {metadata_rows} metadata rows, {media_rows} media rows, {identifier_rows} identifier rows")

cur.close()
conn.close()
