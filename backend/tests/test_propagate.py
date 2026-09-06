"""
M13: SGP4 accuracy tests.
Checks that propagate.py produces sane, expected-range results
for known object types (LEO ISS-like, GEO).
"""

import sys
from pathlib import Path
from datetime import datetime, timezone

# allow importing from logic/ without packaging
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "logic"))

from propagate import get_latest_elements, build_satellite, propagate


def test_leo_object_altitude_in_range():
    """object_id 2 is ISS-like (LEO, ~51.6 deg inclination) — altitude should be ~350-450km."""
    row = get_latest_elements(2)
    sat = build_satellite(row)
    now = datetime.now(timezone.utc)
    position, velocity, altitude = propagate(sat, now)

    assert 350 <= altitude <= 450, f"LEO altitude out of expected range: {altitude}"


def test_geo_object_altitude_in_range():
    """object_id 77 is a communications/GEO object — altitude should be ~35,500-36,000km."""
    row = get_latest_elements(77)
    sat = build_satellite(row)
    now = datetime.now(timezone.utc)
    position, velocity, altitude = propagate(sat, now)

    assert 35500 <= altitude <= 36000, f"GEO altitude out of expected range: {altitude}"


def test_position_and_velocity_are_nonzero_vectors():
    """Sanity check: propagation shouldn't return all-zero vectors."""
    row = get_latest_elements(2)
    sat = build_satellite(row)
    now = datetime.now(timezone.utc)
    position, velocity, altitude = propagate(sat, now)

    assert any(abs(c) > 0 for c in position), "Position vector is all zero"
    assert any(abs(c) > 0 for c in velocity), "Velocity vector is all zero"


def test_propagation_is_deterministic_for_same_time():
    """Same input time should always give the same output (no randomness)."""
    row = get_latest_elements(2)
    sat1 = build_satellite(row)
    sat2 = build_satellite(row)
    when = datetime(2026, 8, 14, 12, 0, 0, tzinfo=timezone.utc)

    result1 = propagate(sat1, when)
    result2 = propagate(sat2, when)

    assert result1 == result2, "Propagation is not deterministic for identical inputs"
