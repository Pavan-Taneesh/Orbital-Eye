"""
SGP4 propagation: given an object's latest orbital_elements row,
compute position/velocity/altitude at a requested UTC datetime.

Usage (standalone test):
    python logic/propagate.py <object_id>
"""
import math
import os
import sys
from datetime import datetime, timezone

import psycopg2
from astropy import units as u
from astropy.coordinates import (
    ITRS,
    TEME,
    CartesianDifferential,
    CartesianRepresentation,
)
from astropy.time import Time
from sgp4.api import WGS72, Satrec, jday


def get_latest_elements(object_id: int):
    """Pull the latest (non-stale-aware) orbital_elements row for one object."""
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        dbname=os.getenv("DB_NAME", "project_db"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD"),
    )
    cur = conn.cursor()
    cur.execute(
        """
        SELECT epoch, mean_motion, eccentricity, inclination,
               ra_of_asc_node, arg_of_pericenter, mean_anomaly,
               bstar, mean_motion_dot, mean_motion_ddot
        FROM orbital_elements
        WHERE object_id = %s
        ORDER BY fetched_at DESC
        LIMIT 1;
        """,
        (object_id,),
    )
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row is None:
        raise ValueError(f"No orbital_elements found for object_id={object_id}")
    return row


def build_satellite(row):
    """Convert DB row (raw TLE units) into an initialized Satrec object."""
    (epoch, mean_motion, eccentricity, inclination,
     raan, argp, mean_anomaly, bstar, mm_dot, mm_ddot) = row

    # unit conversions: degrees -> radians
    inclo = math.radians(inclination)
    nodeo = math.radians(raan)
    argpo = math.radians(argp)
    mo = math.radians(mean_anomaly)

    # mean motion: revs/day -> radians/minute
    no_kozai = mean_motion * (2 * math.pi) / 1440.0

    # epoch -> Julian day / fraction (sgp4init wants epoch as days since 1949 Dec 31 00:00 UTC)
    jd, fr = jday(epoch.year, epoch.month, epoch.day,
                  epoch.hour, epoch.minute, epoch.second + epoch.microsecond / 1e6)
    epoch_sgp4 = (jd + fr) - 2433281.5  # sgp4 epoch reference point

    sat = Satrec()
    sat.sgp4init(
        WGS72,            # gravity model
        'i',               # 'i' = improved mode (standard for sgp4init)
        0,                 # satnum placeholder (not used for propagation itself)
        epoch_sgp4,
        bstar,
        mm_dot,
        mm_ddot,
        eccentricity,
        argpo,
        inclo,
        mo,
        no_kozai,
        nodeo,
    )
    return sat

def teme_to_ecef(position_km, velocity_km_s, when: datetime):
    """
    Convert TEME position/velocity (km, km/s) to ECEF (ITRS) at a given UTC time.
    Uses astropy's built-in ITRS frame as the Earth-fixed target (ITRF-equivalent, IAU-standard).
    """
    t = Time(when)

    cart = CartesianRepresentation(*position_km, unit=u.km)
    cart_vel = CartesianDifferential(*velocity_km_s, unit=u.km / u.s)
    cart = cart.with_differentials(cart_vel)

    teme = TEME(cart, obstime=t)
    itrs = teme.transform_to(ITRS(obstime=t))

    pos = itrs.cartesian.xyz.to(u.km).value
    vel = itrs.cartesian.differentials['s'].d_xyz.to(u.km / u.s).value

    return tuple(pos), tuple(vel)

def propagate(sat: Satrec, when: datetime):
    """Propagate to a given UTC datetime. Returns (position_km, velocity_km_s, altitude_km) in ECEF/ITRS."""
    jd, fr = jday(when.year, when.month, when.day,
                  when.hour, when.minute, when.second + when.microsecond / 1e6)
    error, position_teme, velocity_teme = sat.sgp4(jd, fr)
    if error != 0:
        raise RuntimeError(f"SGP4 propagation error code {error}")

    position, velocity = teme_to_ecef(position_teme, velocity_teme, when)

    earth_radius_km = 6371.0
    r = math.sqrt(sum(c ** 2 for c in position))
    altitude_km = r - earth_radius_km

    return position, velocity, altitude_km


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python logic/propagate.py <object_id>")
        sys.exit(1)

    object_id = int(sys.argv[1])
    row = get_latest_elements(object_id)
    sat = build_satellite(row)

    now = datetime.now(timezone.utc)
    position, velocity, altitude_km = propagate(sat, now)

    print(f"object_id: {object_id}")
    print(f"time (UTC): {now.isoformat()}")
    print(f"position (km, ECI): {position}")
    print(f"velocity (km/s, ECI): {velocity}")
    print(f"altitude (km): {altitude_km:.2f}")
