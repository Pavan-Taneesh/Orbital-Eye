# Contract A — Backend API (Confirmed, Built, Tested)

Author: Person 2 (backend). Status: **implemented and tested** — no longer a draft.
Base: FastAPI. All responses JSON. All endpoints prefixed `/api/v1`.
Local base URL (dev): `http://127.0.0.1:8000/api/v1` — each person runs their own local instance for now (no shared always-on server yet).

CORS is enabled (`allow_origins=["*"]` for now, will restrict once frontend origin is known).

**Note on `frame`:** **Resolved.** SGP4 output is TEME natively, but the backend converts to ECEF (Earth-fixed) before returning — using astropy's TEME→ITRS transform. `frame` in the `/state` response now reads `"ECEF"`. This was confirmed with Person 1: conversion happens once, backend-side, so every frontend consumer (render, hover, click, orbit path) gets ready-to-use Earth-fixed coordinates with no client-side conversion needed. Also matches search/list pagination metadata added since the last version of this doc (see endpoint #2/#3 below).

Search/list endpoints also now return pagination metadata (`total_count`, `limit`, `offset`, `has_more`) and `object_id` is validated as positive across object-scoped endpoints (returns `400` on invalid input) — both added since the previous version of this doc.

---

## 1. Health check
`GET /api/v1/health`

Response:
```json
{"status": "ok"}
```

## 2. Search
`GET /api/v1/objects/search?q=<text>&category=<id>&limit=<n>&offset=<n>`
- `q`: matches against object `name` (case-insensitive substring)
- `category`: optional, filters by category_id (1-7)
- `limit`: default 20, max 100
- `offset`: default 0

**Real tested response** (`q=ISS&limit=1`):
```json
{
  "results": [
    {"object_id": 1, "name": "ISS (ZARYA)", "norad_id": 25544, "category_id": 1}
  ],
  "count": 1,
  "total_count": 2,
  "limit": 1,
  "offset": 0,
  "has_more": true
}
```

## 3. Category filter / listing
`GET /api/v1/objects?category=<id>&limit=<n>&offset=<n>`

Same pagination shape as search (`total_count`, `limit`, `offset`, `has_more`).

**Real tested response** (`category=1&limit=5`):
```json
{
  "results": [
    {"object_id": 1, "name": "ISS (ZARYA)", "norad_id": 25544, "category_id": 1},
    {"object_id": 2, "name": "POISK", "norad_id": 36086, "category_id": 1},
    {"object_id": 3, "name": "CSS (TIANHE)", "norad_id": 48274, "category_id": 1}
  ],
  "count": 3,
  "total_count": 3,
  "limit": 5,
  "offset": 0,
  "has_more": false
}
```

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

**400 if `object_id` is not positive:**
```json
{"detail": "object_id must be positive"}
```

**404 if object_id doesn't exist:**
```json
{"detail": "object not found"}
```

## 5. Orbital state (Contract C)
`GET /api/v1/objects/{object_id}/state`

**Real tested response** (`object_id=1`) — **note `frame` is now `"ECEF"`, converted backend-side:**
```json
{
  "object_id": 1,
  "position": [-4700.136502960001, -2354.1818383273367, 4291.947063017316],
  "velocity": [-0.018980350238962274, -6.454470044947357, -3.5474196423010653],
  "altitude": 415.32926301916996,
  "epoch": "2026-08-13T03:34:14.082240",
  "frame": "ECEF",
  "source": "Space-Track",
  "age_hours": 353.19,
  "status": "stale"
}
```
`status` is one of: `fresh`, `stale`, `error`, `unavailable`. `position`/`velocity` are Earth-fixed (ECEF/ITRS) — ready to hand directly to Cesium, no further conversion needed on the frontend.

**400 if `object_id` is not positive:**
```json
{"detail": "object_id must be positive"}
```

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
Note: `raw_latest_row.epoch` and `raw_latest_row` orbital elements are the untouched TLE-derived values (still TEME-relative by nature, since this is raw SGP4 input, not the converted output) — diagnostics intentionally exposes backend internals, so don't treat this endpoint's numbers as ECEF.

**400 if `object_id` is not positive:**
```json
{"detail": "object_id must be positive"}
```

**404 if no orbital data exists for the object:**
```json
{"detail": "no orbital data for this object"}
```

---

## How to run this locally (for Person 3)

Each person runs their own local backend instance for now — no shared always-on server yet.

1. Clone the repo, `cd backend`
2. Install deps: `pip install fastapi "uvicorn[standard]" psycopg2 sgp4 python-dotenv astropy`
3. Set up local Postgres with the schema (`db/schema.sql`, `db/seed.sql`, `db/views.sql`) — real data population requires running the ingestion scripts, or contact Person 2 for a data subset if you just need something to test against.
4. Run: `python -m uvicorn main:app --reload --port 8000`
5. Base URL: `http://127.0.0.1:8000/api/v1`

If you want to build against the API shapes without setting up a real DB yet, the JSON examples above are real, tested output — safe to mock/hardcode for early development (types, API client, application state) before wiring up a live connection.

## Resolved items
- ~~TEME → ECEF conversion~~ — **done.** Confirmed with Person 1, implemented backend-side via astropy, live in the `/state` endpoint. `frame` now reads `"ECEF"`.

## Still open items
- **Shared/always-on backend instance**: not set up yet — under discussion, may move to a small cloud Postgres later if local-instance coordination becomes a bottleneck.
- **Auth, rate limiting**: still open, not yet decided.