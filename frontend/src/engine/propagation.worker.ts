/* ============================================================
   Propagation worker (Vite module worker).
     new Worker(new URL('./propagation.worker.ts', import.meta.url), { type: 'module' })
   Owns the satrecs; the main thread only ever sees Float32Arrays.
   The hot path ('propagate') fills a buffer the main thread transferred
   in and transfers it straight back: no per-tick allocation of buffers.
   ============================================================ */

import { SatelliteSet } from './sgp4Core'
import type { FromWorker, ToWorker } from './workerProtocol'

/* tsconfig uses the DOM lib, so describe the dedicated-worker scope we use. */
interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
}
const scope = self as unknown as WorkerScope

let sats: SatelliteSet | null = null

function post(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer)
}

scope.onmessage = (event) => {
  const msg = event.data
  try {
    switch (msg.type) {
      case 'init': {
        const t0 = performance.now()
        try {
          sats = new SatelliteSet(msg.packed)
        } catch (err) {
          sats = null
          post({ type: 'initFailed', message: err instanceof Error ? err.message : String(err) })
          return
        }
        post({
          type: 'ready',
          count: sats.count,
          invalid: sats.invalidCount,
          initMs: performance.now() - t0,
        })
        return
      }
      case 'propagate': {
        const t0 = performance.now()
        const out = new Float32Array(msg.buffer)
        if (sats) sats.propagateAll(msg.timeMs, out)
        else out.fill(Number.NaN)
        post(
          {
            type: 'positions',
            requestId: msg.requestId,
            timeMs: msg.timeMs,
            buffer: msg.buffer,
            passMs: performance.now() - t0,
          },
          [msg.buffer],
        )
        return
      }
      case 'detail': {
        if (!sats || msg.index < 0 || msg.index >= sats.count) {
          post({ type: 'detail', requestId: msg.requestId, result: null, error: 'unknown index' })
          return
        }
        const result = sats.detail(msg.index, msg.timeMs)
        post({
          type: 'detail',
          requestId: msg.requestId,
          result,
          error: result ? null : sats.isValid(msg.index) ? 'decayed' : 'invalid elements',
        })
        return
      }
      case 'orbitPath': {
        if (!sats || msg.index < 0 || msg.index >= sats.count) {
          post({
            type: 'orbitPath',
            requestId: msg.requestId,
            points: new ArrayBuffer(0),
            latLon: null,
            periodMin: Number.NaN,
            error: 'unknown index',
          })
          return
        }
        const { points, latLon, periodMin } = sats.orbitPath(
          msg.index,
          msg.timeMs,
          msg.samples,
          msg.groundTrack,
        )
        const transfer: Transferable[] = [points.buffer]
        if (latLon) transfer.push(latLon.buffer)
        post(
          {
            type: 'orbitPath',
            requestId: msg.requestId,
            points: points.buffer,
            latLon: latLon ? latLon.buffer : null,
            periodMin,
            error: sats.isValid(msg.index) ? null : 'invalid elements',
          },
          transfer,
        )
        return
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Always answer the request: never strand a transferred buffer or a pending promise.
    if (msg.type === 'propagate') {
      new Float32Array(msg.buffer).fill(Number.NaN)
      post(
        { type: 'positions', requestId: msg.requestId, timeMs: msg.timeMs, buffer: msg.buffer, passMs: 0 },
        [msg.buffer],
      )
    } else if (msg.type === 'detail') {
      post({ type: 'detail', requestId: msg.requestId, result: null, error: message })
    } else if (msg.type === 'orbitPath') {
      post({
        type: 'orbitPath',
        requestId: msg.requestId,
        points: new ArrayBuffer(0),
        latLon: null,
        periodMin: Number.NaN,
        error: message,
      })
    }
    post({ type: 'error', message })
  }
}
