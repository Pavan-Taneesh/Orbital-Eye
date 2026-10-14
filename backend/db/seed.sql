-- Seven fixed categories, per project spec
INSERT INTO categories (name, color_hex) VALUES
    ('Space Stations', '#FFD700'),
    ('Navigation',      '#00BFFF'),
    ('Communication',   '#FF6347'),
    ('Weather',         '#32CD32'),
    ('Scientific',      '#9370DB'),
    ('Rocket Bodies',   '#FF8C00'),
    ('Space Debris',    '#808080');

-- Known data sources
INSERT INTO sources (name, url) VALUES
    ('CelesTrak',   'https://celestrak.org'),
    ('Space-Track', 'https://www.space-track.org'),
    ('SatNOGS',     'https://satnogs.org'),
    ('ESA DISCOS',  'https://discosweb.esoc.esa.int');

-- Test fixtures: orbital elements for propagation tests
-- object_id 2: ISS-like (LEO, ~51.6 deg inclination, ~400km altitude)
-- object_id 77: GEO communications satellite (~35,786km altitude)

-- Insert test objects with explicit IDs for test determinism
INSERT INTO objects (object_id, name, norad_id, cospar_id, category_id) VALUES
    (2, 'ISS (ZARYA)', 25544, '1998-067A', 1)
    ON CONFLICT (object_id) DO NOTHING;

INSERT INTO objects (object_id, name, norad_id, cospar_id, category_id) VALUES
    (77, 'INTELSAT 901', 26900, '2001-024A', 3)
    ON CONFLICT (object_id) DO NOTHING;

-- Orbital elements for test objects (source_id=1 = CelesTrak)
-- epoch is in UTC, fetched_at defaults to NOW()

-- object_id 2: ISS-like (LEO, ~400km altitude, 51.6° inclination)
-- Typical ISS orbital elements (mean_motion ~15.5 revs/day, ecc ~0.0003, incl ~51.6°)
INSERT INTO orbital_elements (object_id, source_id, epoch, mean_motion, eccentricity, inclination,
    ra_of_asc_node, arg_of_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot,
    element_set_no, rev_at_epoch) VALUES
    (2, 1, '2026-01-15 12:00:00+00', 15.54182780, 0.0003672, 51.6416,
     123.4567, 234.5678, 345.6789, 0.00012345, 0.00000123, 0,
     1, 12345)
    ON CONFLICT DO NOTHING;

-- object_id 77: GEO communications satellite (~35,786km altitude)
-- GEO: mean_motion ~1.0027 revs/day, ecc ~0.00008, incl ~0.05°
INSERT INTO orbital_elements (object_id, source_id, epoch, mean_motion, eccentricity, inclination,
    ra_of_asc_node, arg_of_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot,
    element_set_no, rev_at_epoch) VALUES
    (77, 1, '2026-01-15 12:00:00+00', 1.002703, 0.000081, 0.05,
     45.1234, 123.4567, 234.5678, 0, 0, 0,
     1, 54321)
    ON CONFLICT DO NOTHING;