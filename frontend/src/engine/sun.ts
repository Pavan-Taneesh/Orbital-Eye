/* ============================================================
   Sun direction in the scene frame.
   Low-precision formula from the Astronomical Almanac (section C,
   "Sun, low precision"): apparent ecliptic longitude good to ~0.01 deg
   for 1950-2050, referred to the mean equator/equinox of date. The
   difference to SGP4's TEME frame (equinox-of-date, nutation-only
   differences) is well under 0.01 deg, far below what a terminator or
   lighting direction can show.
   ============================================================ */

import { julianDate } from './frames'

const DEG = Math.PI / 180

/** Unit vector Earth -> Sun in ECI (equator/equinox of date). */
export function sunDirectionEci(simTimeMs: number): [number, number, number] {
  const n = julianDate(simTimeMs) - 2451545.0
  const L = (280.46 + 0.9856474 * n) * DEG
  const g = (357.528 + 0.9856003 * n) * DEG
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG
  const eps = (23.439 - 0.0000004 * n) * DEG
  const sinL = Math.sin(lambda)
  return [Math.cos(lambda), Math.cos(eps) * sinL, Math.sin(eps) * sinL]
}

/** Unit vector Earth -> Sun in SCENE coordinates (ECI (x,y,z) -> scene (x,z,-y)). */
export function sunDirectionScene(simTimeMs: number): [number, number, number] {
  const [x, y, z] = sunDirectionEci(simTimeMs)
  return [x, z, -y]
}
