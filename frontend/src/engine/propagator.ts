/* ============================================================
   Propagator: main-thread façade over propagation.worker.ts.
   ------------------------------------------------------------
   SGP4 for the whole catalog runs in a worker at only a few Hz
   (tickHz, default 8, 4 on low-end). Every frame the renderer calls
   setTime(simTimeMs) and writePositions(target, simTimeMs); positions
   are interpolated between the last two worker samples, so motion is
   smooth at 60 fps.

   Interpolation is "nlerp": linear between the two samples, then the
   radius is rescaled to the linearly interpolated radius. That removes
   the chord sag a plain lerp would show for fast-moving LEO objects.
   It stays accurate while the sim-time span between samples is small
   relative to the orbital period: span = warp / effectiveHz seconds.
   At warp 1800 and 4 Hz that is 450 s (~0.5 rad of a 92 min LEO orbit;
   along-track timing error < ~0.3%, radial error ~0). The scheme breaks
   down as the span approaches half an orbit (~2,700 s for LEO), i.e.
   do not offer warps above ~5,000x without raising tickHz.

   Buffers: a ring of three Float32Arrays (two held for interpolation,
   one in flight to the worker) is allocated once and transferred back
   and forth; nothing is allocated per tick.
   ============================================================ */

import type { LiveState } from './contract'
import { eciKmToScene, SCENE_UNITS_PER_KM } from './frames'
import { packedTransferList, packOmm } from './ommPack'
import type { DetailResult, FromWorker, OmmInput, ToWorker } from './workerProtocol'

export { earthRotationY, EARTH_RADIUS_SCENE, SCENE_UNITS_PER_KM } from './frames'

export interface PropagatorOptions {
  /** Target worker sample rate. 8 by default; use 4 on low-end devices. Clamped to [1, 30]. */
  tickHz?: number
  /**
   * What writePositions() writes for objects without a valid position.
   * 'nan' (default): NaN (set a manual boundingSphere / frustumCulled=false on the geometry).
   * 'origin': 0,0,0, i.e. hidden inside the opaque Earth.
   */
  invalidFill?: 'nan' | 'origin'
  /** Called once the worker has built all satrecs. */
  onReady?: (info: { count: number; invalid: number; initMs: number }) => void
  /**
   * Called once if the propagator becomes unusable (worker failed to load, crashed,
   * or could not initialise the catalog). `status` is then 'failed'.
   */
  onError?: (message: string) => void
}

export type PropagatorStatus = 'loading' | 'ready' | 'failed'

export type LiveStateDetailed = LiveState & {
  positionScene: [number, number, number]
  /** TEME/ECI velocity, km/s (axes are ECI, not scene). */
  velocityKmS: [number, number, number]
}

interface Sample {
  buf: Float32Array
  timeMs: number
  gen: number
}

interface Pending<T> {
  resolve: (value: T) => void
  reject: (reason: Error) => void
}

type OrbitReply = Extract<FromWorker, { type: 'orbitPath' }>

const MIN_HZ = 1
const MAX_HZ = 30

export class Propagator {
  readonly count: number

  private worker: Worker | null
  private readonly free: Float32Array[] = []
  private a: Sample | null = null
  private b: Sample | null = null
  private inflight = false
  private gen = 0
  private nextRequestId = 1
  private readonly inflightGen = new Map<number, number>()
  private readonly details = new Map<number, Pending<DetailResult>>()
  private readonly orbits = new Map<number, Pending<OrbitReply>>()

  private tickHz: number
  private readonly invalidValue: number
  private lastPassMs = 0
  private latencyMs = 0
  private requestSentAt = 0
  private nextRequestAt = 0

  /* sim-rate estimate from consecutive setTime() calls */
  private lastSimMs = Number.NaN
  private lastWallMs = Number.NaN
  private simRate = 1
  private rateUnknown = true

  private state: PropagatorStatus = 'loading'
  private readonly onErrorCb: ((message: string) => void) | undefined
  private disposed = false
  private lastError: string | null = null

  constructor(omm: readonly OmmInput[], opts: PropagatorOptions = {}) {
    this.count = omm.length
    this.tickHz = clampHz(opts.tickHz ?? 8)
    this.invalidValue = opts.invalidFill === 'origin' ? 0 : Number.NaN
    this.onErrorCb = opts.onError
    for (let i = 0; i < 3; i++) this.free.push(new Float32Array(this.count * 3))

    this.worker = new Worker(new URL('./propagation.worker.ts', import.meta.url), {
      type: 'module',
      name: 'orbital-eye-propagation',
    })
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.onMessage(event.data, opts)
    this.worker.onerror = (event) => {
      event.preventDefault()
      this.fail(event.message || 'propagation worker failed to load or crashed')
    }
    this.worker.onmessageerror = () => this.fail('propagation worker message could not be decoded')
    // One transfer of typed columns instead of cloning tens of thousands of objects.
    const packed = packOmm(omm)
    this.send({ type: 'init', packed }, packedTransferList(packed))
  }

  /** True once at least one sample has arrived (writePositions has data). */
  get hasPositions(): boolean {
    return this.b !== null
  }

  get isReady(): boolean {
    return this.state === 'ready'
  }

  /** 'loading' until the worker has built the satrecs; 'failed' is terminal. */
  get status(): PropagatorStatus {
    return this.state
  }

  /** Last full-pass cost in the worker, ms (useful for an adaptive quality HUD). */
  get workerPassMs(): number {
    return this.lastPassMs
  }

  /** Worker sample rate currently achieved (<= tickHz when the worker is the bottleneck). */
  get effectiveHz(): number {
    return 1000 / this.intervalMs()
  }

  get error(): string | null {
    return this.lastError
  }

  setTickHz(hz: number): void {
    this.tickHz = clampHz(hz)
  }

  /**
   * Call once per frame with the current simulation time. Issues at most one
   * worker request at a time, at <= tickHz, aimed slightly ahead of simTimeMs so
   * that the render time sits between the two held samples.
   */
  setTime(simTimeMs: number): void {
    if (this.disposed || !Number.isFinite(simTimeMs)) return
    const wall = performance.now()

    if (Number.isFinite(this.lastSimMs)) {
      const dWall = wall - this.lastWallMs
      const dSim = simTimeMs - this.lastSimMs
      if (dWall > 0.5) {
        // Paused (measured rate 0) and time moved by more than clock jitter (coarse
        // Date.now() in some browsers): a seek or resume, not a rate sample.
        const pausedJump = !this.rateUnknown && this.simRate === 0 && Math.abs(dSim) > 1_000
        const predicted = this.lastSimMs + this.simRate * dWall
        const jumpTolerance = Math.max(5_000, Math.abs(this.simRate) * this.intervalMs() * 4)
        const jumped =
          pausedJump ||
          (!this.rateUnknown &&
            Math.abs(simTimeMs - predicted) > jumpTolerance &&
            Math.abs(dSim) > 5_000)
        if (jumped) {
          // Seek or warp change: a single frame's dSim/dWall is not a rate, keep the old
          // estimate and re-measure on the next frame.
          this.discontinuity()
          this.rateUnknown = true
        } else {
          this.simRate = dSim / dWall
          this.rateUnknown = false
        }
      }
    }
    this.lastSimMs = simTimeMs
    this.lastWallMs = wall

    // Held samples far from the render time (seek, warp change, long tab sleep).
    if (this.b && this.b.gen === this.gen) {
      const lo = Math.min(this.a?.timeMs ?? this.b.timeMs, this.b.timeMs)
      const hi = this.b.timeMs
      const slack = Math.max(5_000, Math.abs(this.simRate) * this.intervalMs() * 4)
      if (simTimeMs < lo - slack || simTimeMs > hi + slack) this.discontinuity()
    }

    if (this.inflight || this.state !== 'ready' || wall < this.nextRequestAt) return
    const lookaheadMs = this.simRate * (this.intervalMs() + this.latencyMs)
    const target = simTimeMs + lookaheadMs
    // Paused and already holding a sample for exactly this time: nothing to do.
    if (this.simRate === 0 && this.b && this.b.gen === this.gen && this.b.timeMs === target) return
    this.request(target, wall)
  }

  /**
   * Fill `target` (length >= 3 * count) with SCENE coordinates at `simTimeMs`.
   * Returns false (target untouched) until the first worker sample arrives.
   */
  writePositions(target: Float32Array, simTimeMs: number): boolean {
    const b = this.b
    if (!b) return false
    const n = Math.min(this.count * 3, target.length)
    const k = SCENE_UNITS_PER_KM
    const bad = this.invalidValue
    const pb = b.buf
    const a = this.a
    let alpha = 1
    if (a && a.gen === b.gen && b.timeMs !== a.timeMs) {
      // Allow one interval of extrapolation when the worker lags, then hold.
      alpha = Math.min(2, Math.max(0, (simTimeMs - a.timeMs) / (b.timeMs - a.timeMs)))
    }

    if (!a || alpha === 1 || a.gen !== b.gen) {
      for (let i = 0; i < n; i += 3) {
        const x = pb[i]
        if (x !== x) {
          target[i] = target[i + 1] = target[i + 2] = bad
          continue
        }
        target[i] = x * k
        target[i + 1] = pb[i + 2] * k
        target[i + 2] = -pb[i + 1] * k
      }
      return true
    }

    const pa = a.buf
    const beta = 1 - alpha
    for (let i = 0; i < n; i += 3) {
      const ax = pa[i]
      const bx = pb[i]
      if (bx !== bx) {
        target[i] = target[i + 1] = target[i + 2] = bad
        continue
      }
      const by = pb[i + 1]
      const bz = pb[i + 2]
      if (ax !== ax) {
        // Newly valid object: no history yet, use the latest sample.
        target[i] = bx * k
        target[i + 1] = bz * k
        target[i + 2] = -by * k
        continue
      }
      const ay = pa[i + 1]
      const az = pa[i + 2]
      const x = ax * beta + bx * alpha
      const y = ay * beta + by * alpha
      const z = az * beta + bz * alpha
      const ra = Math.sqrt(ax * ax + ay * ay + az * az)
      const rb = Math.sqrt(bx * bx + by * by + bz * bz)
      const len = Math.sqrt(x * x + y * y + z * z)
      const s = len > 0 ? ((ra * beta + rb * alpha) / len) * k : k
      target[i] = x * s
      target[i + 1] = z * s
      target[i + 2] = -y * s
    }
    return true
  }

  /** Exact (non-interpolated) SGP4 state of one object. Rejects if it cannot be propagated. */
  getLiveState(index: number, simTimeMs: number): Promise<LiveStateDetailed> {
    return new Promise<DetailResult>((resolve, reject) => {
      if (!this.worker) return reject(new Error(this.lastError ?? 'Propagator disposed'))
      const requestId = this.nextRequestId++
      this.details.set(requestId, { resolve, reject })
      this.send({ type: 'detail', requestId, index, timeMs: simTimeMs })
    }).then((d) => {
      const positionScene: [number, number, number] = [0, 0, 0]
      eciKmToScene(d.position[0], d.position[1], d.position[2], positionScene)
      return {
        altitudeKm: d.altitudeKm,
        speedKmS: d.speedKmS,
        latDeg: d.latDeg,
        lonDeg: d.lonDeg,
        positionScene,
        velocityKmS: d.velocity,
      }
    })
  }

  /**
   * One revolution starting at simTimeMs, `samples` points in SCENE coordinates
   * (3 floats each; draw as a closed line loop). Points where SGP4 fails are NaN.
   */
  async getOrbitPath(index: number, simTimeMs: number, samples = 180): Promise<Float32Array> {
    const reply = await this.orbitRequest(index, simTimeMs, samples, false)
    const eci = new Float32Array(reply.points)
    for (let i = 0; i < eci.length; i += 3) eciKmToScene(eci[i], eci[i + 1], eci[i + 2], eci, i)
    return eci
  }

  /** Sub-satellite points (lat, lon degrees, 2 floats each) over one revolution from simTimeMs. */
  async getGroundTrack(index: number, simTimeMs: number, samples = 180): Promise<Float32Array> {
    const reply = await this.orbitRequest(index, simTimeMs, samples, true)
    return reply.latLon ? new Float32Array(reply.latLon) : new Float32Array(0)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker?.terminate()
    this.worker = null
    this.failAll(new Error('Propagator disposed'))
    this.a = this.b = null
    this.free.length = 0
    this.inflightGen.clear()
  }

  /* ---------------------------------------------------------------- */

  private orbitRequest(
    index: number,
    timeMs: number,
    samples: number,
    groundTrack: boolean,
  ): Promise<OrbitReply> {
    return new Promise<OrbitReply>((resolve, reject) => {
      if (!this.worker) return reject(new Error(this.lastError ?? 'Propagator disposed'))
      const requestId = this.nextRequestId++
      this.orbits.set(requestId, { resolve, reject })
      this.send({ type: 'orbitPath', requestId, index, timeMs, samples, groundTrack })
    })
  }

  private intervalMs(): number {
    // Adaptive: never ask for more than ~50% worker duty cycle.
    return Math.max(1000 / this.tickHz, this.lastPassMs * 2)
  }

  private request(targetMs: number, wall: number): void {
    const buf = this.free.pop()
    if (!buf || !this.worker) return
    const requestId = this.nextRequestId++
    this.inflight = true
    this.inflightGen.set(requestId, this.gen)
    this.requestSentAt = wall
    this.nextRequestAt = wall + this.intervalMs()
    const buffer = buf.buffer as ArrayBuffer
    this.send({ type: 'propagate', requestId, timeMs: targetMs, buffer }, [buffer])
  }

  /** Time jumped: samples in hand must not be interpolated against new ones. */
  private discontinuity(): void {
    this.gen++
    if (this.a) {
      this.free.push(this.a.buf)
      this.a = null
    }
    // Keep `b` on screen until a fresh sample replaces it; request immediately.
    this.nextRequestAt = 0
  }

  private onMessage(msg: FromWorker, opts: PropagatorOptions): void {
    if (this.disposed) return
    switch (msg.type) {
      case 'initFailed':
        this.fail(`catalog initialisation failed: ${msg.message}`)
        return
      case 'ready':
        this.state = 'ready'
        opts.onReady?.({ count: msg.count, invalid: msg.invalid, initMs: msg.initMs })
        return
      case 'positions': {
        const gen = this.inflightGen.get(msg.requestId) ?? -1
        this.inflightGen.delete(msg.requestId)
        this.inflight = false
        this.lastPassMs = msg.passMs
        const rtt = performance.now() - this.requestSentAt
        this.latencyMs = this.latencyMs === 0 ? rtt : this.latencyMs * 0.8 + rtt * 0.2
        const sample: Sample = { buf: new Float32Array(msg.buffer), timeMs: msg.timeMs, gen }
        if (gen !== this.gen) {
          this.free.push(sample.buf)
          return
        }
        if (this.b && this.b.gen !== this.gen) {
          // First sample after a discontinuity replaces the stale one outright.
          this.free.push(this.b.buf)
          this.b = sample
          return
        }
        if (this.a) this.free.push(this.a.buf)
        this.a = this.b
        this.b = sample
        return
      }
      case 'detail': {
        const p = this.details.get(msg.requestId)
        if (!p) return
        this.details.delete(msg.requestId)
        if (msg.result) p.resolve(msg.result)
        else p.reject(new Error(msg.error ?? 'propagation failed'))
        return
      }
      case 'orbitPath': {
        const p = this.orbits.get(msg.requestId)
        if (!p) return
        this.orbits.delete(msg.requestId)
        if (msg.error && msg.points.byteLength === 0) p.reject(new Error(msg.error))
        else p.resolve(msg)
        return
      }
      case 'error':
        this.lastError = msg.message
        return
    }
  }

  /** Terminal failure: stop requesting, reject everything pending, tell the UI once. */
  private fail(message: string): void {
    if (this.state === 'failed' || this.disposed) return
    this.state = 'failed'
    this.lastError = message
    this.inflight = false
    this.inflightGen.clear()
    this.failAll(new Error(message))
    this.worker?.terminate()
    this.worker = null
    try {
      this.onErrorCb?.(message)
    } catch (err) {
      console.error('[propagator] onError callback failed', err)
    }
  }

  private failAll(err: Error): void {
    for (const p of this.details.values()) p.reject(err)
    for (const p of this.orbits.values()) p.reject(err)
    this.details.clear()
    this.orbits.clear()
  }

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer)
  }
}

function clampHz(hz: number): number {
  return Number.isFinite(hz) ? Math.min(MAX_HZ, Math.max(MIN_HZ, hz)) : 8
}
