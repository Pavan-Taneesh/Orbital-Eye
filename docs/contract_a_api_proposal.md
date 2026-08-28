# Contract A — Backend API (Confirmed, Built, Tested)

Author: Person 2 (backend). Status: **implemented and tested** — no longer a draft.
Base: FastAPI. All responses JSON. All endpoints prefixed `/api/v1`.
Local base URL (dev): `http://127.0.0.1:8000/api/v1` — each person runs their own local instance for now (no shared always-on server yet).

CORS is enabled (`allow_origins=["*"]` for now, will restrict once frontend origin is known).

**Note on `frame`:** SGP4 output is currently TEME, not Earth-fixed. Pending confirmation from Person 1 on TEME→ECEF conversion (see `teme_ecef_question_for_person1.md`). Until resolved, `frame` will read `"TEME"` — do not assume ECEF yet.

---

## 1. Health check
`GET /api/v1/health`

Response:
```json
{"status": "ok"}
```

## 2. Search
`GET /api/v1/objects/search?q=<text>&category=<id>&limit=<n>`
- `q`: matches against object `name` (case-insensitive substring)
- `category`: optional, filters by category_id (1-7)
- `limit`: default 20, max 100

**Real tested response** (`q=ISS`):
```json
{
  "results": [
    {"object_id": 1, "name": "ISS (ZARYA)", "norad_id": 25544, "category_id": 1},
    {"object_id": 4, "name": "ISS (NAUKA)", "norad_id": 49044, "category_id": 1}
  ],
  "count": 2
}
```

## 3. Category filter / listing
`GET /api/v1/objects?category=<id>&limit=<n>&offset=<n>`

**Real tested response** (`category=1&limit=5`):
```json
{
  "results": [
    {"object_id": 1, "name": "ISS (ZARYA)", "norad_id": 25544, "category_id": 1},
    {"object_id": 2, "name": "POISK", "norad_id": 36086, "category_id": 1},
    {"object_id": 3, "name": "CSS (TIANHE)", "norad_id": 48274, "category_id": 1}
  ],
  "count": 3
}
```
(shape identical to search results)

## 4. Object lookup / details
`GET /api/v1/objects/{object_id}`

**Real tested response** (`object_id=1`):
```json
{
  "object_id": 1,
  "name": "ISS (ZARYA)",
  "category": "Space Stations",
  "norad_id": 25544,
  "metadata": {
    "status": "alive",
    "countries": "RU,US",
    "launch_date": "1998-11-20T00:00:00Z",
    "mass": "450000.0",
    "shape": "Irr"
  },
  "media": [
    {"url": "...", "media_type": "image", "source_id": 3}
  ]
}
```
`metadata` keys vary per object depending on what's resolved in `resolved_metadata`. `media` may be an empty list if no image exists.

**404 if object_id doesn't exist:**
```json
{"detail": "object not found"}
```

## 5. Orbital state (Contract C)
`GET /api/v1/objects/{object_id}/state`

**Real tested response** (`object_id=1`):
```json
{
  "object_id": 1,
  "position": [5071.426570992608, -3464.9902249714746, 2896.65414762014],
  "velocity": [0.9937172344157711, 5.691523993932631, 5.038512165808138],
  "altitude": 419.8858019438567,
  "epoch": "2026-08-13T03:34:14.082240",
  "frame": "TEME",
  "source": "Space-Track",
  "age_hours": 8.24,
  "status": "fresh"
}
```
`status` is one of: `fresh`, `stale`, `error`, `unavailable`.

**404 if no orbital data exists for the object:**
```json
{"detail": "no orbital data for this object"}
```

## 6. Media
Not a separate endpoint — `media` is included directly in the object lookup response (#4 above). Skipped as a standalone route since it would be redundant.

## 7. Diagnostics (dev-only, for Person 3)
`GET /api/v1/objects/{object_id}/diagnostics`

**Real tested response** (`object_id=1`, truncated — full raw_latest_row has all orbital_elements columns):
```json
{
  "object_id": 1,
  "raw_latest_row": {
    "element_id": 19910,
    "object_id": 1,
    "source_id": 2,
    "epoch": "2026-08-13T03:34:14.082240",
    "mean_motion": 15.49426097,
    "eccentricity": 0.0007533,
    "inclination": 51.6324,
    "...": "..."
  },
  "sgp4_error_code": 0,
  "staleness": {
    "age_hours": 9.01,
    "threshold_hours": 24,
    "is_stale": false
  },
  "ingestion_history": [
    {"element_id": 1, "source_id": 1, "epoch": "...", "fetched_at": "..."}
  ],
  "ingestion_row_count": 10
}
```

**404 if no orbital data exists for the object:**
```json
{"detail": "no orbital data for this object"}
```

---

## How to run this locally (for Person 3)

Each person runs their own local backend instance for now — no shared always-on server yet.

1. Clone the repo, `cd backend`
2. Install deps: `pip install fastapi "uvicorn[standard]" psycopg2 sgp4 python-dotenv`
3. Set up local Postgres with the schema (`db/schema.sql`, `db/seed.sql`, `db/views.sql`) — real data population requires running the ingestion scripts, or contact Person 2 for a data subset if you just need something to test against.
4. Run: `python -m uvicorn main:app --reload --port 8000`
5. Base URL: `http://127.0.0.1:8000/api/v1`

If you want to build against the API shapes without setting up a real DB yet, the JSON examples above are real, tested output — safe to mock/hardcode for early development (types, API client, application state) before wiring up a live connection.

## Open items
- **TEME → ECEF conversion**: pending Person 1's confirmation. `frame` field will change from `"TEME"` to `"ECEF"` once implemented — don't hardcode assumptions about which frame you're getting yet.
- **Shared/always-on backend instance**: not set up yet — under discussion, may move to a small cloud Postgres later if local-instance coordination becomes a bottleneck.
- **Pagination style, auth, rate limiting**: still open, not yet decided (see original open questions).