import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent.parent))
import os
import time

import requests

from db import get_connection

SOURCE_ID = 4  # ESA DISCOS
API_BASE = "https://discosweb.esoc.esa.int/api/objects"
PAGE_SIZE = 100
SLEEP_BETWEEN_PAGES = 0.5  # seconds, be polite to the API
START_PAGE = int(os.environ.get("DISCOS_START_PAGE", "1"))  # resume point
MAX_RETRIES = 3
RETRY_WAIT = 5  # seconds, backoff on transient errors (e.g. 503)

DISCOS_TOKEN = os.environ.get("DISCOS_TOKEN")
if not DISCOS_TOKEN:
    raise SystemExit("Set DISCOS_TOKEN env var first.")

HEADERS = {
    "Authorization": f"Bearer {DISCOS_TOKEN}",
    "DiscosWeb-Api-Version": "2",
}

conn = get_connection()
cur = conn.cursor()

# --- Build norad_id -> object_id lookup from DB (all categories) ---
cur.execute("SELECT object_id, norad_id FROM objects WHERE norad_id IS NOT NULL;")
norad_to_object = {row[1]: row[0] for row in cur.fetchall()}
print(f"{len(norad_to_object)} objects in DB to match against DISCOS")

matched = 0
metadata_rows = 0
page_number = START_PAGE
total_fetched = 0

if START_PAGE > 1:
    print(f"Resuming from page {START_PAGE}")

while True:
    params = {
        "page[number]": page_number,
        "page[size]": PAGE_SIZE,
    }

    response: requests.Response | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        response = requests.get(API_BASE, headers=HEADERS, params=params, timeout=30)
        if response.status_code == 200:
            break
        if response.status_code in (502, 503, 504):
            print(f"Page {page_number}: status {response.status_code}, retry {attempt}/{MAX_RETRIES} in {RETRY_WAIT}s")
            time.sleep(RETRY_WAIT)
        else:
            break  # non-transient error, don't retry

    if response is None or response.status_code != 200:
        status = response.status_code if response is not None else "no response"
        body = response.text[:200] if response is not None else "no response"
        print(f"Page {page_number}: fetch failed after retries, status {status}, body: {body}")
        print(f"To resume later: set DISCOS_START_PAGE={page_number}")
        break

    payload = response.json()
    records = payload.get("data", [])

    if not records:
        break  # no more pages

    total_fetched += len(records)

    for item in records:
        attrs = item.get("attributes", {})
        norad_id = attrs.get("satno")

        if norad_id is None or norad_id not in norad_to_object:
            continue

        object_id = norad_to_object[norad_id]
        matched += 1

        field_map = {
            "mass": attrs.get("mass"),
            "shape": attrs.get("shape"),
            "length_m": attrs.get("length"),
            "height_m": attrs.get("height"),
            "depth_m": attrs.get("depth"),
            "operator": attrs.get("country"),
            "launch_date": attrs.get("launchDate"),
            "reentry_epoch": attrs.get("reentryEpoch"),
        }

        for field_name, field_value in field_map.items():
            if field_value is not None:
                cur.execute("""
                    INSERT INTO metadata (object_id, source_id, field_name, field_value)
                    VALUES (%s, %s, %s, %s);
                """, (object_id, SOURCE_ID, field_name, str(field_value)))
                metadata_rows += 1

    conn.commit()
    print(f"Page {page_number}: {len(records)} records processed, {matched} matched so far")

    # stop if this page came back smaller than PAGE_SIZE (last page)
    if len(records) < PAGE_SIZE:
        break

    page_number += 1
    time.sleep(SLEEP_BETWEEN_PAGES)

print(f"Total DISCOS records fetched: {total_fetched}")
print(f"Matched: {matched} objects")
print(f"Inserted: {metadata_rows} metadata rows")

cur.close()
conn.close()
