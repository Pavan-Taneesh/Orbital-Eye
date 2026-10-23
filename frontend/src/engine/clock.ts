/* ============================================================
   Simulation clock. Framework-free; call now() every frame.
   Sim time advances by wall-clock delta x warp. While following
   real time (initially, and after goLive()) now() is Date.now()
   exactly, so a sleeping tab never drifts, and `live` is true.
   `live` is true ONLY while following: seek(), pause() and any warp
   other than 1 stop following; only goLive() resumes it.
   ============================================================ */

import type { TimeState } from './contract'

export const WARP_PRESETS = [0, 1, 10, 60, 300, 1800] as const

/** Hard limit so a bad input cannot send the clock somewhere SGP4 is meaningless. */
const MAX_ABS_WARP = 100_000

export interface SimClock {
  /** Current simulated UTC, epoch ms. Cheap; call every frame. */
  now(): number
  readonly state: TimeState
  setWarp(warp: number): void
  /** Resume at the last non-zero warp (1 if none). */
  play(): void
  /** warp = 0, remembering the previous warp for play(). */
  pause(): void
  /** Jump to wall-clock now at warp 1 and keep following it. */
  goLive(): void
  /** Jump to an absolute sim time (epoch ms); keeps the current warp. */
  seek(simTimeMs: number): void
  /** Notified on every control change (not every frame). Returns unsubscribe. */
  subscribe(fn: (state: TimeState) => void): () => void
  /** Removes the visibilitychange listener and all subscribers. */
  dispose(): void
}

export function createSimClock(): SimClock {
  let warp = 1
  let lastNonZeroWarp = 1
  let following = true
  let baseSim = Date.now()
  let basePerf = performance.now()
  const listeners = new Set<(state: TimeState) => void>()

  const now = (): number => {
    if (following) return Date.now()
    return baseSim + (performance.now() - basePerf) * warp
  }

  const rebase = (): void => {
    baseSim = now()
    basePerf = performance.now()
  }

  const snapshot = (): TimeState => {
    const simTimeMs = now()
    return { simTimeMs, warp, live: following }
  }

  const emit = (): void => {
    const s = snapshot()
    for (const fn of listeners) {
      try {
        fn(s)
      } catch (err) {
        console.error('[simClock] listener failed', err)
      }
    }
  }

  // After sleep/background the performance clock may have paused while Date.now()
  // kept going. When following, re-anchor and tell subscribers the (jumped) time.
  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible' || !following) return
    baseSim = Date.now()
    basePerf = performance.now()
    emit()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)

  return {
    now,
    get state() {
      return snapshot()
    },
    setWarp(next: number) {
      if (!Number.isFinite(next)) return
      const w = Math.max(-MAX_ABS_WARP, Math.min(MAX_ABS_WARP, next))
      if (w === warp && !(following && w !== 1)) return
      rebase()
      following = false
      warp = w
      if (w !== 0) lastNonZeroWarp = w
      emit()
    },
    play() {
      if (warp !== 0) return
      rebase()
      warp = lastNonZeroWarp
      emit()
    },
    pause() {
      if (warp === 0) return
      rebase()
      following = false
      lastNonZeroWarp = warp
      warp = 0
      emit()
    },
    goLive() {
      following = true
      warp = 1
      lastNonZeroWarp = 1
      baseSim = Date.now()
      basePerf = performance.now()
      emit()
    },
    seek(simTimeMs: number) {
      if (!Number.isFinite(simTimeMs)) return
      following = false
      baseSim = simTimeMs
      basePerf = performance.now()
      emit()
    },
    dispose() {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      listeners.clear()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
