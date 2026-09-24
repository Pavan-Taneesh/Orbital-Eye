import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parent.parent))
from db import get_connection

import os
import time

import requests

# --- Config ---
SOURCE_ID = 2  # Space-Track
LOGIN_URL = "https://www.space-track.org/ajaxauth/login"
QUERY_BASE = "https://www.space-track.org/basicspacedata/query/class/gp"
BATCH_SIZE = 100          # NORAD IDs per request (URL length safety)
SLEEP_BETWEEN_REQUESTS = 2  # seconds, Space-Track rate limit courtesy

ST_USER = os.environ.get("SPACETRACK_USER")
ST_PASS = os.environ.get("SPACETRACK_PASS")

if not ST_USER or not ST_PASS:
    raise SystemExit("Set SPACETRACK_USER and SPACETRACK_PASS env vars first.")

conn = get_connection()
cur = conn.cursor()

# --- Login (session-based, cookies persist for subsequent queries) ---
session = requests.Session()
login_resp = session.post(LOGIN_URL, data={"identity": ST_USER, "password": ST_PASS})

if login_resp.status_code != 200 or "Login" in login_resp.text[:200]:
    raise SystemExit(f"Space-Track login failed: {login_resp.status_code}")

print("Space-Track login OK")

# --- Get NORAD IDs already in DB for categories 1-5 (cross-verify targets) ---
cur.execute("""
    SELECT norad_id FROM objects WHERE category_id IN (1,2,3,4,5);
""")
norad_ids = [row[0] for row in cur.fetchall()]
print(f"Cross-verifying {len(norad_ids)} objects against Space-Track")

total_inserted = 0
not_found = 0

for i in range(0, len(norad_ids), BATCH_SIZE):
    batch = norad_ids[i:i + BATCH_SIZE]
    id_list = ",".join(str(n) for n in batch)

    url = f"{QUERY_BASE}/NORAD_CAT_ID/{id_list}/orderby/NORAD_CAT_ID/format/json"
    response = session.get(url)

    if response.status_code != 200 or not response.text.strip():
        print(f"Batch {i // BATCH_SIZE}: fetch failed, status {response.status_code}")
        time.sleep(SLEEP_BETWEEN_REQUESTS)
        continue

    data = response.json()
    found_ids = set()

    for sat in data:
        try:
            norad_id = int(sat["NORAD_CAT_ID"])
            found_ids.add(norad_id)

            cur.execute("SELECT object_id FROM objects WHERE norad_id = %s", (norad_id,))
            row = cur.fetchone()
            if not row:
                continue  # shouldn't happen, object should already exist
            object_id = row[0]

            cur.execute("""
                INSERT INTO orbital_elements (
                    object_id, source_id, epoch, mean_motion, eccentricity,
                    inclination, ra_of_asc_node, arg_of_pericenter, mean_anomaly,
                    bstar, mean_motion_dot, mean_motion_ddot,
                    element_set_no, rev_at_epoch
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);
            """, (
                object_id, SOURCE_ID, sat["EPOCH"], sat["MEAN_MOTION"], sat["ECCENTRICITY"],
                sat["INCLINATION"], sat["RA_OF_ASC_NODE"], sat["ARG_OF_PERICENTER"],
                sat["MEAN_ANOMALY"], sat["BSTAR"], sat["MEAN_MOTION_DOT"],
                sat["MEAN_MOTION_DDOT"], sat["ELEMENT_SET_NO"], sat["REV_AT_EPOCH"]
            ))
            total_inserted += 1
        except (KeyError, ValueError, TypeError) as e:
            print(f"Skipped one record in batch {i // BATCH_SIZE}: {e}")
            continue

    missing = set(batch) - found_ids
    not_found += len(missing)

    conn.commit()
    print(f"Batch {i // BATCH_SIZE}: {len(found_ids)} matched, {len(missing)} not on Space-Track")
    time.sleep(SLEEP_BETWEEN_REQUESTS)

print(f"Total Space-Track orbital_elements rows inserted: {total_inserted}")
print(f"Total objects not found on Space-Track: {not_found}")

cur.close()
conn.close()
