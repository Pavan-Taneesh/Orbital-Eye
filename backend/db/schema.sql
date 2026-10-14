-- =========================================================
-- 1. sources — where data comes from (CelesTrak, Space-Track...)
-- =========================================================
CREATE TABLE sources (
    source_id   SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    url         TEXT,
    created_at  TIMESTAMP DEFAULT NOW()
);

-- =========================================================
-- 2. categories — the 7 fixed groups (space stations, nav, etc)
-- =========================================================
CREATE TABLE categories (
    category_id SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    color_hex   TEXT
);

-- =========================================================
-- 3. objects — the canonical record, ONE row per real satellite/debris
-- =========================================================
CREATE TABLE objects (
    object_id     SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    norad_id      INTEGER UNIQUE,        -- primary matching key
    cospar_id     TEXT UNIQUE,           -- e.g. '1998-067A', secondary match key
    category_id   INTEGER REFERENCES categories(category_id),
    object_type   TEXT,
    created_at    TIMESTAMP DEFAULT NOW(),
    created_at    TIMESTAMP DEFAULT NOW(),
    updated_at    TIMESTAMP DEFAULT NOW()
);

-- =========================================================
-- 4. orbital_elements — TLE data, one row per object per update
--    (history kept, not overwritten — lets us track staleness)
-- =========================================================
CREATE TABLE orbital_elements (
    element_id          SERIAL PRIMARY KEY,
    object_id           INTEGER NOT NULL REFERENCES objects(object_id),
    source_id           INTEGER NOT NULL REFERENCES sources(source_id),
    epoch                TIMESTAMP NOT NULL,
    mean_motion          DOUBLE PRECISION,
    eccentricity         DOUBLE PRECISION,
    inclination          DOUBLE PRECISION,
    ra_of_asc_node       DOUBLE PRECISION,
    arg_of_pericenter    DOUBLE PRECISION,
    mean_anomaly         DOUBLE PRECISION,
    bstar                DOUBLE PRECISION,
    mean_motion_dot      DOUBLE PRECISION,
    mean_motion_ddot     DOUBLE PRECISION,
    element_set_no       INTEGER,
    rev_at_epoch         INTEGER,
    fetched_at           TIMESTAMP DEFAULT NOW()  -- when WE pulled this, not the epoch
);

-- =========================================================
-- 5. metadata — static facts (launch date, operator...), per field
--    conflict-safe: source + timestamp + confidence per row
-- =========================================================
CREATE TABLE metadata (
    metadata_id  SERIAL PRIMARY KEY,
    object_id    INTEGER NOT NULL REFERENCES objects(object_id),
    source_id    INTEGER NOT NULL REFERENCES sources(source_id),
    field_name   TEXT NOT NULL,      -- e.g. 'launch_date', 'operator', 'mass'
    field_value  TEXT NOT NULL,      -- stored as text, cast when read
    confidence   REAL DEFAULT 1.0,   -- 0.0 - 1.0, how much we trust this
    recorded_at  TIMESTAMP DEFAULT NOW()
);

-- =========================================================
-- 6. media — images/links per object
-- =========================================================
CREATE TABLE media (
    media_id     SERIAL PRIMARY KEY,
    object_id    INTEGER NOT NULL REFERENCES objects(object_id),
    url          TEXT NOT NULL,
    media_type   TEXT DEFAULT 'image',
    source_id    INTEGER REFERENCES sources(source_id)
);

-- =========================================================
-- 7. identifiers — alt IDs from each source, used for matching
-- =========================================================
CREATE TABLE identifiers (
    identifier_id  SERIAL PRIMARY KEY,
    object_id      INTEGER NOT NULL REFERENCES objects(object_id),
    source_id      INTEGER NOT NULL REFERENCES sources(source_id),
    external_id    TEXT NOT NULL,
    UNIQUE (source_id, external_id)
);
-- =========================================================
-- 8. resolved_metadata — one winning value per object+field,
--    computed by conflict resolution logic (never edited by hand)
-- =========================================================
CREATE TABLE resolved_metadata (
    object_id     INTEGER NOT NULL REFERENCES objects(object_id),
    field_name    TEXT NOT NULL,
    field_value   TEXT NOT NULL,
    source_id     INTEGER NOT NULL REFERENCES sources(source_id),
    resolved_at   TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (object_id, field_name)
);