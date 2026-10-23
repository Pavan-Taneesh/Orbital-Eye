/* Packs OMM objects into transferable Float64Array columns for the worker
   (one transfer instead of structured-cloning tens of thousands of objects).
   No satellite.js import here: this runs on the main thread. */

import type { OmmInput, PackedOmm } from './workerProtocol'

/** Parses an OMM EPOCH (no zone = UTC, like json2satrec) to Unix ms; NaN if unparseable. */
export function parseOmmEpoch(epoch: string): number {
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(epoch)
  return Date.parse(hasZone ? epoch : `${epoch}Z`)
}

export function packOmm(omm: readonly OmmInput[]): PackedOmm {
  const n = omm.length
  const col = () => new Float64Array(n)
  const p: PackedOmm = {
    count: n,
    epochMs: col(),
    meanMotion: col(),
    eccentricity: col(),
    inclination: col(),
    raan: col(),
    argPericenter: col(),
    meanAnomaly: col(),
    bstar: col(),
    meanMotionDot: col(),
    meanMotionDdot: col(),
    norad: col(),
  }
  for (let i = 0; i < n; i++) {
    const o = omm[i]
    p.epochMs[i] = parseOmmEpoch(o.EPOCH)
    p.meanMotion[i] = o.MEAN_MOTION
    p.eccentricity[i] = o.ECCENTRICITY
    p.inclination[i] = o.INCLINATION
    p.raan[i] = o.RA_OF_ASC_NODE
    p.argPericenter[i] = o.ARG_OF_PERICENTER
    p.meanAnomaly[i] = o.MEAN_ANOMALY
    p.bstar[i] = o.BSTAR
    p.meanMotionDot[i] = o.MEAN_MOTION_DOT
    p.meanMotionDdot[i] = o.MEAN_MOTION_DDOT
    p.norad[i] = o.NORAD_CAT_ID ?? i
  }
  return p
}

export function packedTransferList(p: PackedOmm): ArrayBuffer[] {
  return [
    p.epochMs,
    p.meanMotion,
    p.eccentricity,
    p.inclination,
    p.raan,
    p.argPericenter,
    p.meanAnomaly,
    p.bstar,
    p.meanMotionDot,
    p.meanMotionDdot,
    p.norad,
  ].map((a) => a.buffer)
}
