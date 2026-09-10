import os
import requests
import psycopg2

conn = psycopg2.connect(
    host=os.getenv("DB_HOST", "localhost"),
    dbname=os.getenv("DB_NAME", "project_db"),
    user=os.getenv("DB_USER", "postgres"),
    password=os.getenv("DB_PASSWORD", ""),
)
cur = conn.cursor()

SOURCE_ID = 1  # CelesTrak

# category_id : (category name, celestrak group)
GROUPS = {
    1: "stations",     # Space Stations
    2: "gps-ops",      # Navigation
    3: "geo",          # Communication
    4: "weather",       # Weather
    5: "science",       # Scientific
}

total_inserted = 0

for category_id, group in GROUPS.items():
    url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json"
    response = requests.get(url, timeout=30)
    data = response.json()

    for sat in data:
        norad_id = sat["NORAD_CAT_ID"]
        name = sat["OBJECT_NAME"]
        cospar_id = sat["OBJECT_ID"]
        epoch = sat["EPOCH"]

        cur.execute("""
            INSERT INTO objects (name, norad_id, cospar_id, category_id)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (norad_id) DO NOTHING
            RETURNING object_id;
        """, (name, norad_id, cospar_id, category_id))

        row = cur.fetchone()
        if row:
            object_id = row[0]
        else:
            cur.execute("SELECT object_id FROM objects WHERE norad_id = %s", (norad_id,))
            object_id = cur.fetchone()[0]

        cur.execute("""
            INSERT INTO orbital_elements (
                object_id, source_id, epoch, mean_motion, eccentricity,
                inclination, ra_of_asc_node, arg_of_pericenter, mean_anomaly,
                bstar, mean_motion_dot, mean_motion_ddot,
                element_set_no, rev_at_epoch
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);
        """, (
            object_id, SOURCE_ID, epoch, sat["MEAN_MOTION"], sat["ECCENTRICITY"],
            sat["INCLINATION"], sat["RA_OF_ASC_NODE"], sat["ARG_OF_PERICENTER"],
            sat["MEAN_ANOMALY"], sat["BSTAR"], sat["MEAN_MOTION_DOT"],
            sat["MEAN_MOTION_DDOT"], sat["ELEMENT_SET_NO"], sat["REV_AT_EPOCH"]
        ))

    total_inserted += len(data)
    print(f"{group}: {len(data)} objects processed")

# --- Rocket Bodies (SATCAT endpoint, catalog info only, no orbit data) ---
ROCKET_BODY_CATEGORY_ID = 6

# NOTE: OBJECT_TYPE is not a valid SATCAT query param (that's what broke it).
# Real params: NAME, INTDES, GROUP, SPECIAL, ACTIVE, ONORBIT, MAX, FORMAT.
# Rocket bodies = name contains "R/B" (per CelesTrak SATCAT definition),
# also sometimes "AKM"/"PKM", excluding "DEB".
satcat_url = "https://celestrak.org/satcat/records.php?NAME=R/B&FORMAT=json"
response = requests.get(satcat_url, timeout=30)

if response.status_code != 200 or not response.text.strip():
    print(f"Rocket bodies fetch failed: status {response.status_code}, body: {response.text[:200]}")
    rocket_bodies = []
else:
    rocket_bodies = response.json()

rb_count = 0
for obj in rocket_bodies:
    name = obj.get("OBJECT_NAME", "")
    if "DEB" in name.upper():
        continue  # safety filter, name-match could theoretically catch a debris entry

    norad_id = obj.get("NORAD_CAT_ID")
    cospar_id = obj.get("OBJECT_ID")

    if not norad_id:
        continue

    cur.execute("""
        INSERT INTO objects (name, norad_id, cospar_id, category_id)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (norad_id) DO NOTHING;
    """, (name, norad_id, cospar_id, ROCKET_BODY_CATEGORY_ID))
    rb_count += 1

print(f"rocket bodies (SATCAT, no orbit data): {rb_count} objects processed")
total_inserted += rb_count

# --- Space Debris (known debris-cloud groups, has orbit data) ---
DEBRIS_CATEGORY_ID = 7
DEBRIS_GROUPS = ["cosmos-1408-debris", "iridium-33-debris", "cosmos-2251-debris", "fengyun-1c-debris"]

debris_count = 0
for group in DEBRIS_GROUPS:
    url = f"https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json"
    response = requests.get(url, timeout=30)
    data = response.json()

    for sat in data:
        norad_id = sat["NORAD_CAT_ID"]
        name = sat["OBJECT_NAME"]
        cospar_id = sat["OBJECT_ID"]
        epoch = sat["EPOCH"]

        cur.execute("""
            INSERT INTO objects (name, norad_id, cospar_id, category_id)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (norad_id) DO NOTHING
            RETURNING object_id;
        """, (name, norad_id, cospar_id, DEBRIS_CATEGORY_ID))

        row = cur.fetchone()
        if row:
            object_id = row[0]
        else:
            cur.execute("SELECT object_id FROM objects WHERE norad_id = %s", (norad_id,))
            object_id = cur.fetchone()[0]

        cur.execute("""
            INSERT INTO orbital_elements (
                object_id, source_id, epoch, mean_motion, eccentricity,
                inclination, ra_of_asc_node, arg_of_pericenter, mean_anomaly,
                bstar, mean_motion_dot, mean_motion_ddot,
                element_set_no, rev_at_epoch
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);
        """, (
            object_id, SOURCE_ID, epoch, sat["MEAN_MOTION"], sat["ECCENTRICITY"],
            sat["INCLINATION"], sat["RA_OF_ASC_NODE"], sat["ARG_OF_PERICENTER"],
            sat["MEAN_ANOMALY"], sat["BSTAR"], sat["MEAN_MOTION_DOT"],
            sat["MEAN_MOTION_DDOT"], sat["ELEMENT_SET_NO"], sat["REV_AT_EPOCH"]
        ))
        debris_count += 1

print(f"debris clouds: {debris_count} objects processed")
total_inserted += debris_count

conn.commit()
print(f"Total: {total_inserted} objects processed across {len(GROUPS)} groups")

cur.close()
conn.close()
