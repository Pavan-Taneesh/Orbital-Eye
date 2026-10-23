/* ============================================================
   TIME CONTROLS
   ------------------------------------------------------------
   Simulation clock face + transport. The clock re-renders once a
   second, never per frame: it samples `getSimTimeMs` when given,
   otherwise extrapolates from the last TimeState it received
   (simTimeMs + elapsed * warp).
   ============================================================ */

import { memo, useEffect, useState } from 'react'
import type { TimeState } from '../engine/contract'
import { IconPause, IconPlay } from './icons'
import { DEFAULT_WARP_PRESETS, formatDuration, formatUtcParts } from './lookups'
import type { WarpPreset } from './lookups'

export interface TimeControlsProps {
  time: TimeState
  /** Optional live reader of the engine clock (sampled once a second). */
  getSimTimeMs?: () => number
  onPlayPause: () => void
  onWarpChange: (warp: number) => void
  /** Jump back to wall-clock now at 1x (live). */
  onNow: () => void
  presets?: readonly WarpPreset[]
}

interface Face {
  base: number
  warp: number
  sim: number
  /** sim - wall clock, ms; null until the first tick. */
  offset: number | null
}

function TimeControlsImpl({
  time,
  getSimTimeMs,
  onPlayPause,
  onWarpChange,
  onNow,
  presets = DEFAULT_WARP_PRESETS,
}: TimeControlsProps) {
  const [face, setFace] = useState<Face>({ base: time.simTimeMs, warp: time.warp, sim: time.simTimeMs, offset: null })

  // A new TimeState from the parent resets the face immediately (render-time sync).
  if (face.base !== time.simTimeMs || face.warp !== time.warp) {
    setFace({ base: time.simTimeMs, warp: time.warp, sim: time.simTimeMs, offset: face.offset })
  }

  useEffect(() => {
    const started = performance.now()
    const tick = () => {
      const sim = getSimTimeMs ? getSimTimeMs() : time.simTimeMs + (performance.now() - started) * time.warp
      setFace((f) => ({ ...f, sim, offset: sim - Date.now() }))
    }
    const first = window.setTimeout(tick, 0)
    const id = window.setInterval(tick, 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [time.simTimeMs, time.warp, getSimTimeMs])

  const { day, time: clock } = formatUtcParts(face.sim)
  const paused = time.warp === 0
  const drift = face.offset !== null && Math.abs(face.offset) >= 5_000 ? face.offset : null

  return (
    <div className="oe-time" role="group" aria-label="Simulation time">
      <div className="oe-time-bar">
        <button
          type="button"
          className="oe-icon-btn oe-play"
          onClick={onPlayPause}
          aria-label={paused ? 'Resume' : 'Pause'}
          title={paused ? 'Resume' : 'Pause'}
        >
          {paused ? <IconPlay /> : <IconPause />}
        </button>

        <div className="oe-clock">
          <time className="oe-clock-time oe-mono" dateTime={Number.isFinite(face.sim) ? new Date(face.sim).toISOString() : undefined}>
            {clock}
            <span className="oe-clock-zone"> UTC</span>
          </time>
          <span className="oe-clock-day">
            {day}
            {time.live ? null : paused ? (
              <span className="oe-clock-drift"> · paused</span>
            ) : drift !== null ? (
              <span className="oe-clock-drift">
                {' '}
                · {formatDuration(drift)} {drift > 0 ? 'ahead' : 'behind'}
              </span>
            ) : null}
          </span>
        </div>

        {/* One element for both states, so keyboard focus survives Now -> Live. */}
        <button
          type="button"
          className={time.live ? 'oe-live' : 'oe-btn oe-btn-sm oe-now'}
          aria-disabled={time.live}
          onClick={time.live ? undefined : onNow}
          title={time.live ? 'Positions match the current time' : 'Jump to the current time'}
        >
          {time.live && <span className="oe-live-dot" aria-hidden="true" />}
          {time.live ? 'Live' : 'Now'}
        </button>

        <div className="oe-warp" role="group" aria-label="Time warp">
          {presets.map((p) => {
            const on = !paused && time.warp === p.warp
            return (
              <button
                key={p.warp}
                type="button"
                className={`oe-seg${on ? ' is-on' : ''}`}
                aria-pressed={on}
                title={p.title}
                onClick={() => onWarpChange(p.warp)}
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export const TimeControls = memo(TimeControlsImpl)
