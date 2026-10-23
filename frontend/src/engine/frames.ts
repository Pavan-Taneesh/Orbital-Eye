/* ============================================================
   Coordinate frames and time helpers shared by the engine.
   ------------------------------------------------------------
   SCENE FRAME (critical, the 3D scene relies on it):
     - Y-up, right-handed, units of EARTH_RADIUS_SCENE per Earth radius.
     - TEME/ECI (x, y, z) km  ->  scene (x, z, -y) * SCENE_UNITS_PER_KM
       i.e. ECI +Z (north pole) is scene +Y, the vernal equinox (ECI +X)
       is scene +X, ECI +Y is scene -Z. This is a proper rotation.
     - The Earth mesh is inertial-frame content rotated about scene +Y
       by GMST, see earthRotationY(). With three.js' SphereGeometry and
       an equirectangular texture, longitude 0 sits on local +X and
       longitude +90E on local -Z, which matches the mapping above.
   ============================================================ */

import { gstime } from './sgp4Lib'

export const EARTH_RADIUS_SCENE = 2.2
/** Mean Earth radius used for the scene scale (not for geodesy). */
export const EARTH_RADIUS_KM = 6371
export const SCENE_UNITS_PER_KM = EARTH_RADIUS_SCENE / EARTH_RADIUS_KM

/** WGS-72 constants, as used by SGP4. */
export const MU_KM3_S2 = 398600.8
export const EARTH_EQUATORIAL_RADIUS_KM = 6378.135

const MS_PER_DAY = 86_400_000
const JD_UNIX_EPOCH = 2440587.5

/** Julian date (UTC, used as UT1) of a Unix epoch-ms timestamp. */
export function julianDate(timeMs: number): number {
  return timeMs / MS_PER_DAY + JD_UNIX_EPOCH
}

/** Unix epoch-ms of a Julian date. */
export function julianDateToMs(jd: number): number {
  return (jd - JD_UNIX_EPOCH) * MS_PER_DAY
}

/** Greenwich mean sidereal time, radians in [0, 2pi). */
export function gmst(timeMs: number): number {
  return gstime(julianDate(timeMs))
}

/**
 * Rotation of the Earth mesh about scene +Y (radians) at `simTimeMs`.
 * Assign to `earthGroup.rotation.y` every frame; Earth-fixed longitude 0
 * then points at the Greenwich direction in the inertial scene frame.
 */
export function earthRotationY(simTimeMs: number): number {
  return gmst(simTimeMs)
}

/** ECI/TEME km -> scene units, written into `out` at `offset`. */
export function eciKmToScene(
  x: number,
  y: number,
  z: number,
  out: Float32Array | number[],
  offset = 0,
): void {
  out[offset] = x * SCENE_UNITS_PER_KM
  out[offset + 1] = z * SCENE_UNITS_PER_KM
  out[offset + 2] = -y * SCENE_UNITS_PER_KM
}

/** ECI/TEME direction or vector -> scene frame axes, without scaling. */
export function eciToSceneAxes(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y]
}
