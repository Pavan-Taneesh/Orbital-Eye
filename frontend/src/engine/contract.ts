/* ============================================================
   ENGINE <-> UI CONTRACT
   ------------------------------------------------------------
   Shared types between the data/propagation engine (src/engine/*)
   and the interface components (src/ui/*). Both sides build
   against this file; change it only with both sides in mind.
   ============================================================ */

/** Backend wire format of GET /api/v1/catalog (one entry per on-orbit object). */
export interface CatalogEntryWire {
  id: number // objects.object_id
  norad: number
  name: string
  cospar: string | null // international designator, e.g. "1998-067A"
  cat: number // backend category_id 1-7
  type: ObjectType
  owner: string | null // CelesTrak SATCAT owner code, e.g. "US", "PRC", "CIS"
  launch: string | null // ISO date "YYYY-MM-DD"
  site: string | null // CelesTrak SATCAT launch site code, e.g. "AFETR"
  rcs: number | null // radar cross-section, m^2
  /** Latest mean elements, CelesTrak OMM field names/units, ready for satellite.js json2satrec. */
  omm: {
    EPOCH: string
    MEAN_MOTION: number // rev/day
    ECCENTRICITY: number
    INCLINATION: number // deg
    RA_OF_ASC_NODE: number // deg
    ARG_OF_PERICENTER: number // deg
    MEAN_ANOMALY: number // deg
    BSTAR: number
    MEAN_MOTION_DOT: number
    MEAN_MOTION_DDOT: number
  }
}

export interface CatalogResponseWire {
  version: string // changes whenever the catalog content changes (also the ETag)
  generated_at: string // ISO timestamp
  total_objects: number // all rows in `objects`, incl. re-entered
  decayed_objects: number // rows known to have re-entered (not in `objects` below)
  objects: CatalogEntryWire[]
}

export type ObjectType = 'PAY' | 'R/B' | 'DEB' | 'UNK'
export type OrbitRegime = 'LEO' | 'MEO' | 'GEO' | 'HEO'

/** Static facts about one tracked object, derived once from the catalog. Immutable. */
export interface CatalogObject {
  readonly id: number
  readonly norad: number
  readonly name: string
  readonly cospar: string | null
  readonly categoryId: number
  readonly objectType: ObjectType
  readonly owner: string | null
  readonly launchDate: string | null
  readonly launchSite: string | null
  readonly rcs: number | null
  readonly epoch: string // element-set epoch, ISO
  readonly periodMin: number
  readonly inclinationDeg: number
  readonly apogeeKm: number
  readonly perigeeKm: number
  readonly eccentricity: number
  readonly regime: OrbitRegime
}

/** Live, propagated state of one object at the current simulation time. */
export interface LiveState {
  altitudeKm: number
  speedKmS: number
  latDeg: number
  lonDeg: number
}

/** Simulation clock as shown/controlled by the UI. */
export interface TimeState {
  simTimeMs: number // current simulated UTC, epoch ms
  warp: number // 0 = paused, 1 = real time, 60 = one minute per second, ...
  live: boolean // true when simTime tracks wall-clock now at warp 1
}

export interface Filters {
  categories: ReadonlySet<number>
  regimes: ReadonlySet<OrbitRegime>
  types: ReadonlySet<ObjectType>
}
