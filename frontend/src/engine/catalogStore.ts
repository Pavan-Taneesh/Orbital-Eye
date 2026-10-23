/* ============================================================
   Catalog + object-details store with IndexedDB persistence.
   ------------------------------------------------------------
   loadCatalog(): stale-while-revalidate.
     - cached (IndexedDB "orbital-eye"/"catalog" or this session's
       memory) -> resolve immediately, then revalidate in the background
       with If-None-Match; 304 = nothing to do, 200 = store + onUpdate().
     - nothing cached -> fetch, store, resolve.
     - IndexedDB unavailable (private mode, blocked, quota) -> memory only.
   getObjectDetails(): api.get() behind a 7-day IndexedDB cache.
   Every value handed out is frozen or a fresh structuredClone copy.
   ============================================================ */

import { api, API_BASE_URL, type ObjectDetails } from '../lib/types'
import type {
  CatalogEntryWire,
  CatalogObject,
  CatalogResponseWire,
  ObjectType,
  OrbitRegime,
} from './contract'
import { EARTH_EQUATORIAL_RADIUS_KM, MU_KM3_S2 } from './frames'
import type { OmmRecord } from './workerProtocol'

export type { OmmRecord } from './workerProtocol'

export interface LoadedCatalog {
  readonly version: string
  readonly generatedAt: string
  readonly totalObjects: number
  readonly decayedObjects: number
  readonly objects: readonly CatalogObject[]
  /** Index-aligned with `objects`; includes NORAD_CAT_ID/OBJECT_ID/OBJECT_NAME for satellite.js. */
  readonly omm: readonly OmmRecord[]
  /** object id -> index */
  readonly byId: ReadonlyMap<number, number>
  /** NORAD catalog number -> index */
  readonly byNorad: ReadonlyMap<number, number>
  readonly fromCache: boolean
  /**
   * Entries left out of `objects`: malformed, duplicate id, or elements SGP4 cannot use
   * (MEAN_MOTION <= 0 / non-finite, eccentricity outside [0, 1)).
   */
  readonly skippedObjects: number
}

export interface LoadCatalogOptions {
  /** Aborts this caller's wait (the shared network request keeps going for other callers). */
  signal?: AbortSignal
  /** Called when a background revalidation brings a newer catalog. */
  onUpdate?: (catalog: LoadedCatalog) => void
}

/* ------------------------------------------------------------------ */
/* IndexedDB (every operation is best-effort and never throws)         */
/* ------------------------------------------------------------------ */

const DB_NAME = 'orbital-eye'
const DB_VERSION = 1
const STORE_CATALOG = 'catalog'
const STORE_DETAILS = 'details'
const CATALOG_KEY = 'current'
const IDB_OPEN_TIMEOUT_MS = 3_000

const IDB_RETRY_AFTER_MS = 30_000

let dbPromise: Promise<IDBDatabase | null> | null = null
/** After a failed/timed-out open, don't retry before this time (avoids an open storm). */
let nextOpenAttemptAt = 0

function adoptDb(db: IDBDatabase): void {
  // Let a future schema version in another tab upgrade instead of blocking.
  db.onversionchange = () => {
    db.close()
    dbPromise = null
  }
  dbPromise = Promise.resolve(db)
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  if (Date.now() < nextOpenAttemptAt) return Promise.resolve(null)
  let failedSync = false
  const attempt = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false
    const done = (db: IDBDatabase | null) => {
      if (settled) {
        // Opened after we gave up waiting: adopt it so later calls use IndexedDB.
        if (db) adoptDb(db)
        return
      }
      settled = true
      clearTimeout(timer)
      if (db) {
        adoptDb(db)
      } else {
        // Not cached forever: a later call (after a short pause) tries again.
        failedSync = true
        dbPromise = null
        nextOpenAttemptAt = Date.now() + IDB_RETRY_AFTER_MS
      }
      resolve(db)
    }
    const timer = setTimeout(() => done(null), IDB_OPEN_TIMEOUT_MS)
    try {
      if (typeof indexedDB === 'undefined') {
        done(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        try {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE_CATALOG)) db.createObjectStore(STORE_CATALOG)
          if (!db.objectStoreNames.contains(STORE_DETAILS)) db.createObjectStore(STORE_DETAILS)
        } catch {
          // fall through: onerror/onsuccess decides
        }
      }
      req.onsuccess = () => {
        try {
          done(req.result)
        } catch {
          done(null)
        }
      }
      req.onerror = () => done(null)
      req.onblocked = () => done(null)
    } catch {
      done(null)
    }
  })
  // Cache the pending attempt unless it already failed synchronously.
  if (!failedSync && !dbPromise) dbPromise = attempt
  return attempt
}

async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  try {
    const db = await openDb()
    if (!db) return undefined
    return await new Promise<T | undefined>((resolve) => {
      try {
        const req = db.transaction(store, 'readonly').objectStore(store).get(key)
        req.onsuccess = () => resolve(req.result as T | undefined)
        req.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  } catch {
    return undefined
  }
}

async function idbPut(store: string, key: IDBValidKey, value: unknown): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite')
        tx.objectStore(store).put(value, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve() // e.g. QuotaExceededError
      } catch {
        resolve()
      }
    })
  } catch {
    // memory-only fallback
  }
}

async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite')
        tx.objectStore(store).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  } catch {
    // best effort
  }
}

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

/** Bump when the stored record format changes; mismatching records are discarded. */
const CATALOG_SCHEMA = 1

/**
 * IndexedDB record. The raw response text is stored (one string is far cheaper to
 * write and read than a structured-clone graph of tens of thousands of objects)
 * and parsed after reading.
 */
interface StoredCatalogRecord {
  schema: number
  etag: string
  savedAt: number
  text: string
}

interface CachedCatalog {
  etag: string
  data: CatalogResponseWire
}

// ~400 KB gzipped: a few seconds even on slow mobile; past this the server is stuck.
const CATALOG_TIMEOUT_MS = 30_000
/** Successful revalidations are at least this far apart within one page session. */
const REVALIDATE_MIN_INTERVAL_MS = 60_000
/** Failed revalidations back off 60 s, 120 s, ... up to this. */
const REVALIDATE_MAX_BACKOFF_MS = 15 * 60_000

let memoryCatalog: CachedCatalog | null = null
let nextRevalidateAt = 0
let revalidateFailures = 0
/** In-flight requests keyed by the If-None-Match sent ('' = unconditional). */
const inflightFetches = new Map<string, Promise<CachedCatalog | null>>()
const derivedCache = new WeakMap<CatalogResponseWire, Omit<LoadedCatalog, 'fromCache'>>()

export async function loadCatalog(opts: LoadCatalogOptions = {}): Promise<LoadedCatalog> {
  const { signal, onUpdate } = opts
  signal?.throwIfAborted()

  let cached = memoryCatalog ?? (await readStoredCatalog())
  signal?.throwIfAborted()

  if (cached && !isUsable(cached.data)) {
    console.warn('[catalog] cached catalog has no usable objects; discarding and refetching')
    await discardCachedCatalog()
    cached = null
  }

  if (cached) {
    memoryCatalog = cached
    if (Date.now() >= nextRevalidateAt) {
      fetchCatalogShared(cached.etag).then(
        (fresh) => {
          if (fresh && !signal?.aborted && onUpdate) onUpdate(toLoaded(fresh.data, false))
        },
        (err: unknown) => {
          console.warn('[catalog] background revalidation failed; keeping cached catalog', err)
        },
      )
    }
    scheduleDetailsPrune()
    return toLoaded(cached.data, true)
  }

  // Unconditional request: never send If-None-Match without a usable local copy.
  const fresh = await abortable(fetchCatalogShared(null), signal)
  if (!fresh) throw new Error('Catalog unavailable')
  scheduleDetailsPrune()
  return toLoaded(fresh.data, false)
}

async function readStoredCatalog(): Promise<CachedCatalog | null> {
  const rec = await idbGet<unknown>(STORE_CATALOG, CATALOG_KEY)
  if (rec === undefined) return null
  const r = (rec && typeof rec === 'object' ? rec : {}) as Partial<StoredCatalogRecord>
  if (
    r.schema === CATALOG_SCHEMA &&
    typeof r.etag === 'string' &&
    typeof r.savedAt === 'number' &&
    typeof r.text === 'string'
  ) {
    try {
      const data: unknown = JSON.parse(r.text)
      if (isCatalogWire(data)) return { etag: r.etag, data }
    } catch {
      // corrupt text: fall through and discard
    }
  }
  console.warn('[catalog] stored catalog is from another schema or corrupt; discarding')
  await discardCachedCatalog()
  return null
}

async function discardCachedCatalog(): Promise<void> {
  memoryCatalog = null
  await idbDelete(STORE_CATALOG, CATALOG_KEY)
}

/** A catalog is unusable when it lists objects but none of them survive validation. */
function isUsable(wire: CatalogResponseWire): boolean {
  return wire.objects.length === 0 || toLoaded(wire, false).objects.length > 0
}

/**
 * One network request per distinct If-None-Match at a time, shared by all callers.
 * Resolves null on 304 (or on a 200 that carries the version we already have).
 */
function fetchCatalogShared(etag: string | null): Promise<CachedCatalog | null> {
  const key = etag ?? ''
  const existing = inflightFetches.get(key)
  if (existing) return existing
  const p = fetchCatalog(etag)
  inflightFetches.set(key, p)
  const clear = () => {
    if (inflightFetches.get(key) === p) inflightFetches.delete(key)
  }
  p.then(clear, clear)
  return p
}

function noteRevalidation(ok: boolean): void {
  if (ok) {
    revalidateFailures = 0
    nextRevalidateAt = Date.now() + REVALIDATE_MIN_INTERVAL_MS
    return
  }
  const backoff = Math.min(
    REVALIDATE_MAX_BACKOFF_MS,
    REVALIDATE_MIN_INTERVAL_MS * 2 ** revalidateFailures,
  )
  revalidateFailures++
  nextRevalidateAt = Date.now() + backoff
}

async function fetchCatalog(etag: string | null): Promise<CachedCatalog | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (etag) headers['If-None-Match'] = etag
    // no-store: we keep our own copy in IndexedDB; don't hold a second one in the HTTP cache.
    const res = await fetch(`${API_BASE_URL}/catalog`, {
      headers,
      cache: 'no-store',
      signal: controller.signal,
    })
    if (res.status === 304) {
      noteRevalidation(true)
      return null
    }
    if (!res.ok) throw new Error(`GET /catalog failed [${res.status}] ${res.statusText}`)
    const text = await res.text()
    const body: unknown = JSON.parse(text)
    if (!isCatalogWire(body)) throw new Error('GET /catalog returned an unexpected shape')
    if (!isUsable(body)) throw new Error('GET /catalog returned no usable objects')
    const fresh: CachedCatalog = {
      // ETag is only readable cross-origin when the server exposes it; fall back to the version.
      etag: res.headers.get('ETag') ?? `"${body.version}"`,
      data: body,
    }
    noteRevalidation(true)
    const changed = memoryCatalog?.data.version !== body.version
    memoryCatalog = fresh
    const record: StoredCatalogRecord = {
      schema: CATALOG_SCHEMA,
      etag: fresh.etag,
      savedAt: Date.now(),
      text,
    }
    void idbPut(STORE_CATALOG, CATALOG_KEY, record)
    // Same version re-sent with 200 (server ignored If-None-Match): no update to announce.
    return changed || etag === null ? fresh : null
  } catch (err) {
    noteRevalidation(false)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

function isCatalogWire(x: unknown): x is CatalogResponseWire {
  if (!x || typeof x !== 'object') return false
  const c = x as Record<string, unknown>
  return typeof c.version === 'string' && Array.isArray(c.objects)
}

const OBJECT_TYPES: readonly ObjectType[] = ['PAY', 'R/B', 'DEB', 'UNK']

function isEntry(e: unknown): e is CatalogEntryWire {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  if (typeof o.id !== 'number' || typeof o.norad !== 'number' || typeof o.name !== 'string') {
    return false
  }
  const m = o.omm as Record<string, unknown> | null | undefined
  if (!m || typeof m !== 'object' || typeof m.EPOCH !== 'string') return false
  for (const k of [
    'MEAN_MOTION',
    'ECCENTRICITY',
    'INCLINATION',
    'RA_OF_ASC_NODE',
    'ARG_OF_PERICENTER',
    'MEAN_ANOMALY',
    'BSTAR',
    'MEAN_MOTION_DOT',
    'MEAN_MOTION_DDOT',
  ] as const) {
    if (typeof m[k] !== 'number' || !Number.isFinite(m[k])) return false
  }
  return true
}

function toLoaded(wire: CatalogResponseWire, fromCache: boolean): LoadedCatalog {
  let base = derivedCache.get(wire)
  if (!base) {
    base = deriveCatalog(wire)
    derivedCache.set(wire, base)
  }
  return Object.freeze({ ...base, fromCache })
}

function deriveCatalog(wire: CatalogResponseWire): Omit<LoadedCatalog, 'fromCache'> {
  const objects: CatalogObject[] = []
  const omm: OmmRecord[] = []
  const byId = new Map<number, number>()
  const byNorad = new Map<number, number>()
  let malformed = 0
  let duplicate = 0
  let badElements = 0

  for (const raw of wire.objects) {
    if (!isEntry(raw)) {
      malformed++
      continue
    }
    if (byId.has(raw.id)) {
      duplicate++
      continue
    }
    if (!hasUsableElements(raw.omm)) {
      badElements++
      continue
    }
    const index = objects.length
    objects.push(deriveObject(raw))
    omm.push(
      Object.freeze({
        EPOCH: raw.omm.EPOCH,
        MEAN_MOTION: raw.omm.MEAN_MOTION,
        ECCENTRICITY: raw.omm.ECCENTRICITY,
        INCLINATION: raw.omm.INCLINATION,
        RA_OF_ASC_NODE: raw.omm.RA_OF_ASC_NODE,
        ARG_OF_PERICENTER: raw.omm.ARG_OF_PERICENTER,
        MEAN_ANOMALY: raw.omm.MEAN_ANOMALY,
        BSTAR: raw.omm.BSTAR,
        MEAN_MOTION_DOT: raw.omm.MEAN_MOTION_DOT,
        MEAN_MOTION_DDOT: raw.omm.MEAN_MOTION_DDOT,
        NORAD_CAT_ID: raw.norad,
        OBJECT_ID: raw.cospar ?? '',
        OBJECT_NAME: raw.name,
      }),
    )
    byId.set(raw.id, index)
    if (!byNorad.has(raw.norad)) byNorad.set(raw.norad, index)
  }
  const skipped = malformed + duplicate + badElements
  if (skipped > 0) {
    console.warn(
      `[catalog] skipped ${skipped} entries (${malformed} malformed, ${duplicate} duplicate, ${badElements} unusable elements)`,
    )
  }

  return Object.freeze({
    version: wire.version,
    generatedAt: typeof wire.generated_at === 'string' ? wire.generated_at : '',
    totalObjects: numberOr(wire.total_objects, objects.length),
    decayedObjects: numberOr(wire.decayed_objects, 0),
    objects: Object.freeze(objects),
    omm: Object.freeze(omm),
    byId: freezeMap(byId),
    byNorad: freezeMap(byNorad),
    skippedObjects: skipped,
  })
}

/** Elements that give a finite period/apsides and that SGP4 can initialise. */
function hasUsableElements(omm: CatalogEntryWire['omm']): boolean {
  return (
    Number.isFinite(omm.MEAN_MOTION) &&
    omm.MEAN_MOTION > 0 &&
    Number.isFinite(omm.ECCENTRICITY) &&
    omm.ECCENTRICITY >= 0 &&
    omm.ECCENTRICITY < 1
  )
}

function deriveObject(e: CatalogEntryWire): CatalogObject {
  const { MEAN_MOTION: revPerDay, ECCENTRICITY: ecc, INCLINATION: incl } = e.omm
  const orbit = orbitShape(revPerDay, ecc)
  return Object.freeze({
    id: e.id,
    norad: e.norad,
    name: e.name,
    cospar: e.cospar ?? null,
    categoryId: e.cat,
    objectType: OBJECT_TYPES.includes(e.type) ? e.type : 'UNK',
    owner: e.owner ?? null,
    launchDate: e.launch ?? null,
    launchSite: e.site ?? null,
    rcs: typeof e.rcs === 'number' ? e.rcs : null,
    epoch: e.omm.EPOCH,
    periodMin: orbit.periodMin,
    inclinationDeg: incl,
    apogeeKm: orbit.apogeeKm,
    perigeeKm: orbit.perigeeKm,
    eccentricity: ecc,
    regime: orbit.regime,
  })
}

/** Period, apsis altitudes and regime from mean motion (rev/day) and eccentricity. */
export function orbitShape(
  revPerDay: number,
  ecc: number,
): { periodMin: number; apogeeKm: number; perigeeKm: number; regime: OrbitRegime } {
  if (!(revPerDay > 0)) {
    return { periodMin: Number.NaN, apogeeKm: Number.NaN, perigeeKm: Number.NaN, regime: 'HEO' }
  }
  const periodMin = 1440 / revPerDay
  const n = (revPerDay * 2 * Math.PI) / 86_400 // rad/s
  const a = Math.cbrt(MU_KM3_S2 / (n * n)) // km
  const apogeeKm = a * (1 + ecc) - EARTH_EQUATORIAL_RADIUS_KM
  const perigeeKm = a * (1 - ecc) - EARTH_EQUATORIAL_RADIUS_KM
  let regime: OrbitRegime
  if (ecc >= 0.25) regime = 'HEO'
  else if (periodMin >= 1400 && periodMin <= 1500 && ecc < 0.05) regime = 'GEO'
  else if (apogeeKm < 2000) regime = 'LEO' // perigee <= apogee, so both are below 2000 km
  else regime = 'MEO'
  return { periodMin, apogeeKm, perigeeKm, regime }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** A Map whose mutators throw, so a shared instance cannot be changed by one consumer. */
function freezeMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  const deny = () => {
    throw new TypeError('catalog maps are read-only')
  }
  Object.defineProperties(map, {
    set: { value: deny },
    delete: { value: deny },
    clear: { value: deny },
  })
  return Object.freeze(map)
}

/* ------------------------------------------------------------------ */
/* Object details                                                      */
/* ------------------------------------------------------------------ */

const DETAILS_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DETAILS_MEMORY_MAX = 200

interface StoredDetails {
  savedAt: number
  data: ObjectDetails
}

const detailsMemory = new Map<number, StoredDetails>()
const detailsInflight = new Map<number, Promise<ObjectDetails>>()

/**
 * Object details, fetched at most once per 7 days per object across reloads.
 * Concurrent calls share one request. Each caller gets its own deep copy.
 */
export async function getObjectDetails(id: number): Promise<ObjectDetails> {
  const mem = detailsMemory.get(id)
  if (mem && Date.now() - mem.savedAt < DETAILS_TTL_MS) return structuredClone(mem.data)

  let p = detailsInflight.get(id)
  if (!p) {
    p = loadDetails(id)
    detailsInflight.set(id, p)
    const clear = () => {
      if (detailsInflight.get(id) === p) detailsInflight.delete(id)
    }
    p.then(clear, clear)
  }
  return structuredClone(await p)
}

function isFreshDetails(rec: unknown): rec is StoredDetails {
  if (!rec || typeof rec !== 'object') return false
  const r = rec as Partial<StoredDetails>
  return (
    typeof r.savedAt === 'number' &&
    !!r.data &&
    typeof r.data === 'object' &&
    Date.now() - r.savedAt < DETAILS_TTL_MS &&
    r.savedAt <= Date.now() + 60_000 // clock moved backwards: treat as stale
  )
}

async function loadDetails(id: number): Promise<ObjectDetails> {
  const stored = await idbGet<unknown>(STORE_DETAILS, id)
  if (isFreshDetails(stored)) {
    rememberDetails(id, stored)
    return stored.data
  }
  if (stored !== undefined) void idbDelete(STORE_DETAILS, id) // expired or corrupt
  const data = await api.get(id)
  const rec: StoredDetails = { savedAt: Date.now(), data }
  rememberDetails(id, rec)
  void idbPut(STORE_DETAILS, id, rec)
  return data
}

function rememberDetails(id: number, rec: StoredDetails): void {
  detailsMemory.delete(id)
  detailsMemory.set(id, rec)
  while (detailsMemory.size > DETAILS_MEMORY_MAX) {
    const oldest = detailsMemory.keys().next().value
    if (oldest === undefined) break
    detailsMemory.delete(oldest)
  }
}

/* Opportunistic cleanup: once per session, shortly after the catalog loads, delete
   expired/corrupt detail records. Bounded so it never becomes a long task. */
const DETAILS_PRUNE_DELAY_MS = 10_000
const DETAILS_PRUNE_MAX_VISITS = 2_000
let detailsPruneScheduled = false

function scheduleDetailsPrune(): void {
  if (detailsPruneScheduled) return
  detailsPruneScheduled = true
  setTimeout(() => void pruneExpiredDetails(), DETAILS_PRUNE_DELAY_MS)
}

async function pruneExpiredDetails(): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_DETAILS, 'readwrite')
        const req = tx.objectStore(STORE_DETAILS).openCursor()
        let visited = 0
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor || visited >= DETAILS_PRUNE_MAX_VISITS) return
          visited++
          if (!isFreshDetails(cursor.value)) cursor.delete()
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  } catch {
    // best effort
  }
}
