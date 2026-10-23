/* Messages exchanged between Propagator (main thread) and propagation.worker.ts. */

import type { CatalogEntryWire } from './contract'

/** OMM as handed to satellite.js: wire elements plus the identity keys json2satrec expects. */
export type OmmRecord = CatalogEntryWire['omm'] & {
  readonly NORAD_CAT_ID: number
  readonly OBJECT_ID: string
  readonly OBJECT_NAME: string
}

/** Elements the propagator needs: identity keys are optional and injected when missing. */
export type OmmInput = CatalogEntryWire['omm'] & {
  readonly NORAD_CAT_ID?: number
  readonly OBJECT_ID?: string
  readonly OBJECT_NAME?: string
}

/** OMM numeric fields as transferable columns (index-aligned with the catalog). */
export interface PackedOmm {
  count: number
  /** Element-set epoch, Unix ms (NaN = unparseable, object is flagged invalid). */
  epochMs: Float64Array<ArrayBuffer>
  meanMotion: Float64Array<ArrayBuffer> // rev/day
  eccentricity: Float64Array<ArrayBuffer>
  inclination: Float64Array<ArrayBuffer> // deg
  raan: Float64Array<ArrayBuffer> // deg
  argPericenter: Float64Array<ArrayBuffer> // deg
  meanAnomaly: Float64Array<ArrayBuffer> // deg
  bstar: Float64Array<ArrayBuffer>
  meanMotionDot: Float64Array<ArrayBuffer>
  meanMotionDdot: Float64Array<ArrayBuffer>
  norad: Float64Array<ArrayBuffer>
}

export type ToWorker =
  | { type: 'init'; packed: PackedOmm }
  | { type: 'propagate'; requestId: number; timeMs: number; buffer: ArrayBuffer }
  | { type: 'detail'; requestId: number; index: number; timeMs: number }
  | {
      type: 'orbitPath'
      requestId: number
      index: number
      timeMs: number
      samples: number
      groundTrack: boolean
    }

export interface DetailResult {
  /** ECI/TEME km */
  position: [number, number, number]
  /** ECI/TEME km/s */
  velocity: [number, number, number]
  altitudeKm: number
  speedKmS: number
  latDeg: number
  lonDeg: number
}

export type FromWorker =
  | { type: 'ready'; count: number; invalid: number; initMs: number }
  | { type: 'initFailed'; message: string }
  | {
      type: 'positions'
      requestId: number
      timeMs: number
      buffer: ArrayBuffer
      passMs: number
    }
  | { type: 'detail'; requestId: number; result: DetailResult | null; error: string | null }
  | {
      type: 'orbitPath'
      requestId: number
      /** ECI km, 3 floats per sample, NaN where propagation failed. */
      points: ArrayBuffer
      /** lat/lon degrees, 2 floats per sample (only when groundTrack was requested). */
      latLon: ArrayBuffer | null
      periodMin: number
      error: string | null
    }
  | { type: 'error'; message: string }
