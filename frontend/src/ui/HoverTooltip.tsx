/* ============================================================
   HOVER TOOLTIP
   ------------------------------------------------------------
   Follows the pointer over the globe. Built for 60 fps:
   - the parent re-renders only when the hovered object (or its
     live numbers) change; pointer moves go through the imperative
     handle `ref.current.setPosition(x, y)`, which writes
     style.transform directly (no React render, no layout);
   - the box size is measured only when the hovered object changes.
   Hidden from assistive tech (the details panel is the accessible
   route) and on touch-only devices via CSS.
   ============================================================ */

import { memo, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { Ref } from 'react'
import type { CatalogObject, LiveState } from '../engine/contract'
import { OBJECT_TYPE_LABELS, formatKm, formatSpeed, formatYear, ownerName } from './lookups'

export interface HoverTooltipHandle {
  /** Move the tooltip to pointer viewport coordinates (clientX / clientY). */
  setPosition: (x: number, y: number) => void
}

export interface HoverTooltipProps {
  /** Hovered object; null hides the tooltip. */
  object: CatalogObject | null
  /** Live state at the current sim time, if available. */
  live?: LiveState | null
  /** Data colour of the object's category. */
  color?: string
  /** Pixel gap between pointer and box. */
  offset?: number
  /** Imperative handle: call `setPosition` from your pointermove handler. */
  ref?: Ref<HoverTooltipHandle>
}

const EDGE = 8

function HoverTooltipImpl({ object, live, color, offset = 14, ref }: HoverTooltipProps) {
  const el = useRef<HTMLDivElement>(null)
  const size = useRef({ w: 0, h: 0 })
  const pos = useRef({ x: -1, y: -1 })
  const offsetRef = useRef(offset)
  const objectId = object?.id ?? null

  const place = () => {
    const node = el.current
    const { x, y } = pos.current
    if (!node || x < 0) return
    const { w, h } = size.current
    const gap = offsetRef.current
    let left = x + gap
    let top = y + gap
    if (left + w + EDGE > window.innerWidth) left = x - gap - w
    if (top + h + EDGE > window.innerHeight) top = y - gap - h
    left = Math.max(EDGE, left)
    top = Math.max(EDGE, top)
    node.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
  }

  useImperativeHandle(ref, () => ({
    setPosition(x: number, y: number) {
      pos.current = { x, y }
      place()
    },
  }))

  // New object: measure once, then place at the last known pointer position.
  useLayoutEffect(() => {
    offsetRef.current = offset
    const node = el.current
    if (!node || objectId === null) return
    size.current = { w: node.offsetWidth, h: node.offsetHeight }
    place()
    // place() reads refs only; re-measure only when the object or offset changes.
  }, [objectId, offset])

  if (!object) return null

  return (
    <div ref={el} className="oe-tooltip" aria-hidden="true">
      <div className="oe-tooltip-head">
        <span className="oe-dot" style={{ background: color ?? 'var(--text-dim)' }} />
        <span className="oe-tooltip-name">{object.name}</span>
      </div>
      <div className="oe-tooltip-meta">
        <span className="oe-badge">{OBJECT_TYPE_LABELS[object.objectType]}</span>
        <span>{ownerName(object.owner)}</span>
        <span className="oe-sep">·</span>
        <span className="oe-mono">{formatYear(object.launchDate)}</span>
      </div>
      <dl className="oe-tooltip-grid">
        <div>
          <dt>Altitude</dt>
          <dd>{live ? formatKm(live.altitudeKm) : '—'}</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{live ? formatSpeed(live.speedKmS) : '—'}</dd>
        </div>
        <div>
          <dt>Orbit</dt>
          <dd>{object.regime}</dd>
        </div>
      </dl>
      <div className="oe-tooltip-hint">Click for details</div>
    </div>
  )
}

export const HoverTooltip = memo(HoverTooltipImpl)
