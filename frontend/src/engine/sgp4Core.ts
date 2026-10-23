/* ============================================================
   SGP4 over a whole catalog (pure, framework-free).
   Used by propagation.worker.ts; also importable from node for
   benchmarks/tests. Positions are TEME (ECI) km.
   ============================================================ */

import {
  checkForDecay,
  degreesLat,
  degreesLong,
  eciToGeodetic,
  json2satrec,
  sgp4,
  type OMMJsonObject,
  type PositionAndVelocity,
  type SatRec,
} from './sgp4Lib'
import { packOmm } from './ommPack'
import { EARTH_EQUATORIAL_RADIUS_KM, gmst, julianDateToMs } from './frames'
import type { DetailResult, OmmInput, PackedOmm } from './workerProtocol'

/** Positions closer to the geocentre than this are treated as decayed (km). */
const MIN_RADIUS_KM = EARTH_EQUATORIAL_RADIUS_KM * 0.98
/** Anything farther than ~2.6x lunar distance is garbage from a broken element set (km). */
const MAX_RADIUS_KM = 1_000_000

function toSatJson(p: PackedOmm, i: number): OMMJsonObject {
  return {
    OBJECT_NAME: `OBJECT ${i}`,
    OBJECT_ID: '',
    NORAD_CAT_ID: p.norad[i],
    ELEMENT_SET_NO: 999,
    // ISO with Z: json2satrec parses it back to the same millisecond.
    EPOCH: new Date(p.epochMs[i]).toISOString(),
    MEAN_MOTION: p.meanMotion[i],
    ECCENTRICITY: p.eccentricity[i],
    INCLINATION: p.inclination[i],
    RA_OF_ASC_NODE: p.raan[i],
    ARG_OF_PERICENTER: p.argPericenter[i],
    MEAN_ANOMALY: p.meanAnomaly[i],
    BSTAR: p.bstar[i],
    MEAN_MOTION_DOT: p.meanMotionDot[i],
    MEAN_MOTION_DDOT: p.meanMotionDdot[i],
  }
}

/** The one validity rule for every SGP4 result the engine uses. */
function validResult(rec: SatRec, pv: PositionAndVelocity | null): pv is PositionAndVelocity {
  if (pv === null || rec.error !== 0 || checkForDecay(rec)) return false
  const p = pv.position
  const r2 = p.x * p.x + p.y * p.y + p.z * p.z
  return r2 >= MIN_RADIUS_KM * MIN_RADIUS_KM && r2 <= MAX_RADIUS_KM * MAX_RADIUS_KM
}

const TWO_PI = 2 * Math.PI
/** Above this eccentricity orbit paths are sampled evenly in eccentric anomaly. */
const ECCENTRIC_SAMPLING_MIN_E = 0.1

export class SatelliteSet {
  readonly count: number
  readonly invalidCount: number
  /** null where the element set could not be initialised (index kept). */
  private readonly recs: (SatRec | null)[]
  /** Element-set epoch per object, Unix ms. */
  private readonly epochMs: Float64Array

  /** Convenience for node scripts/tests: pack plain OMM objects first. */
  static fromOmm(omm: readonly OmmInput[]): SatelliteSet {
    return new SatelliteSet(packOmm(omm))
  }

  constructor(packed: PackedOmm) {
    const n = packed.count
    this.count = n
    this.recs = new Array<SatRec | null>(n)
    this.epochMs = new Float64Array(n)
    let invalid = 0
    for (let i = 0; i < n; i++) {
      let rec: SatRec | null = null
      try {
        const candidate = Number.isFinite(packed.epochMs[i])
          ? json2satrec(toSatJson(packed, i))
          : null
        if (
          candidate &&
          candidate.error === 0 &&
          Number.isFinite(candidate.jdsatepoch) &&
          Number.isFinite(candidate.no) &&
          candidate.no > 0
        ) {
          rec = candidate
        }
      } catch {
        rec = null
      }
      if (rec === null) invalid++
      this.recs[i] = rec
      this.epochMs[i] = rec ? julianDateToMs(rec.jdsatepoch) : Number.NaN
    }
    this.invalidCount = invalid
  }

  isValid(index: number): boolean {
    return this.recs[index] != null
  }

  /** Mean-motion period in minutes (NaN for invalid objects). */
  periodMin(index: number): number {
    const rec = this.recs[index]
    return rec ? (2 * Math.PI) / rec.no : Number.NaN
  }

  /**
   * Full SGP4 pass. Writes x,y,z km (TEME) per object into `out`
   * (length >= 3 * count); NaN for invalid or decayed objects. Allocation-free
   * apart from satellite.js' own result objects.
   */
  propagateAll(timeMs: number, out: Float32Array): void {
    const recs = this.recs
    const epochMs = this.epochMs
    for (let i = 0, o = 0; i < recs.length; i++, o += 3) {
      const rec = recs[i]
      if (rec === null) {
        out[o] = out[o + 1] = out[o + 2] = Number.NaN
        continue
      }
      const pv = sgp4(rec, (timeMs - epochMs[i]) / 60_000)
      if (!validResult(rec, pv)) {
        out[o] = out[o + 1] = out[o + 2] = Number.NaN
        continue
      }
      const p = pv.position
      out[o] = p.x
      out[o + 1] = p.y
      out[o + 2] = p.z
    }
  }

  /** Position/velocity/geodetic state of one object, or null if it cannot be propagated. */
  detail(index: number, timeMs: number): DetailResult | null {
    const rec = this.recs[index]
    if (!rec) return null
    const pv = sgp4(rec, (timeMs - this.epochMs[index]) / 60_000)
    if (!validResult(rec, pv)) return null
    const { position: p, velocity: v } = pv
    const geo = eciToGeodetic(p, gmst(timeMs))
    return {
      position: [p.x, p.y, p.z],
      velocity: [v.x, v.y, v.z],
      altitudeKm: geo.height,
      speedKmS: Math.hypot(v.x, v.y, v.z),
      latDeg: degreesLat(geo.latitude),
      lonDeg: degreesLong(geo.longitude),
    }
  }

  /**
   * One revolution starting at `timeMs`, `samples` points in time order (draw as a
   * closed loop). Near-circular orbits are sampled evenly in time; for e >= 0.1 the
   * samples are evenly spaced in eccentric anomaly, which concentrates them around
   * perigee where the path curves hardest. ECI km; NaN where the result fails the
   * same validity checks as propagateAll(). With `groundTrack`, also returns
   * sub-satellite lat/lon (deg) per sample.
   */
  orbitPath(
    index: number,
    timeMs: number,
    samples: number,
    groundTrack: boolean,
  ): { points: Float32Array<ArrayBuffer>; latLon: Float32Array<ArrayBuffer> | null; periodMin: number } {
    const n = Math.max(2, Math.min(4096, Math.floor(samples)))
    const points = new Float32Array(n * 3).fill(Number.NaN)
    const latLon = groundTrack ? new Float32Array(n * 2).fill(Number.NaN) : null
    const rec = this.recs[index]
    const periodMin = this.periodMin(index)
    if (!rec || !Number.isFinite(periodMin)) return { points, latLon, periodMin }
    const epochMs = this.epochMs[index]
    const periodMs = periodMin * 60_000

    // Time offsets (ms from timeMs) of each sample, ascending.
    const offsets = new Float64Array(n)
    const pv0 = sgp4(rec, (timeMs - epochMs) / 60_000)
    const e = validResult(rec, pv0) ? pv0.meanElements.em : 0
    if (pv0 !== null && e >= ECCENTRIC_SAMPLING_MIN_E && e < 1) {
      const m0 = ((pv0.meanElements.mm % TWO_PI) + TWO_PI) % TWO_PI
      let first = 0
      for (let k = 0; k < n; k++) {
        const E = (TWO_PI * k) / n
        const M = E - e * Math.sin(E)
        const dM = (((M - m0) % TWO_PI) + TWO_PI) % TWO_PI
        offsets[k] = (dM / TWO_PI) * periodMs
        if (offsets[k] < offsets[first]) first = k
      }
      // Rotate so the sequence starts at the current position and runs forward in time.
      const rotated = new Float64Array(n)
      for (let j = 0; j < n; j++) rotated[j] = offsets[(first + j) % n]
      rotated[0] = 0 // start exactly at the current position
      offsets.set(rotated)
    } else {
      for (let k = 0; k < n; k++) offsets[k] = (k * periodMs) / n
    }

    for (let k = 0; k < n; k++) {
      const t = timeMs + offsets[k]
      const pv = sgp4(rec, (t - epochMs) / 60_000)
      if (!validResult(rec, pv)) continue
      const p = pv.position
      points[k * 3] = p.x
      points[k * 3 + 1] = p.y
      points[k * 3 + 2] = p.z
      if (latLon) {
        const geo = eciToGeodetic(p, gmst(t))
        latLon[k * 2] = degreesLat(geo.latitude)
        latLon[k * 2 + 1] = degreesLong(geo.longitude)
      }
    }
    return { points, latLon, periodMin }
  }
}
