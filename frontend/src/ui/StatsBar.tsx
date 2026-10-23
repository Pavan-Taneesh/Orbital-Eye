/* ============================================================
   STATS BAR
   ------------------------------------------------------------
   One quiet line at the top: how many objects are tracked, the
   split by type and orbit, how many re-entered objects are left
   out, and how fresh the element sets are. Collapses to the
   headline count on narrow screens.
   ============================================================ */

import { memo } from 'react'
import type { ObjectType, OrbitRegime } from '../engine/contract'
import { useWallClock } from './hooks'
import {
  OBJECT_TYPES,
  OBJECT_TYPE_PLURAL,
  ORBIT_REGIMES,
  REGIME_LABELS,
  ageDays,
  formatAge,
  formatCount,
} from './lookups'

export interface StatsBarProps {
  tracked: number
  /** Objects passing the current filters; shown when it differs from `tracked`. */
  visible?: number
  byType: Readonly<Record<ObjectType, number>>
  byRegime: Readonly<Record<OrbitRegime, number>>
  decayed: number
  /** Catalog entries left out because their data or orbital elements are unusable. */
  skipped?: number
  /** ISO timestamp of the catalog snapshot (CatalogResponseWire.generated_at). */
  generatedAt: string | null
  loading?: boolean
}

function StatsBarImpl({
  tracked,
  visible,
  byType,
  byRegime,
  decayed,
  skipped = 0,
  generatedAt,
  loading = false,
}: StatsBarProps) {
  const now = useWallClock(60_000)
  const days = ageDays(generatedAt, now)
  const stale = days !== null && days > 2

  if (loading) {
    return (
      <div className="oe-stats" aria-busy="true">
        <span className="oe-stats-main">Loading catalog…</span>
      </div>
    )
  }

  const filtered = visible !== undefined && visible !== tracked

  return (
    <section className="oe-stats" aria-label="Catalog overview">
      <span className="oe-stats-main">
        {filtered && (
          <>
            <strong className="oe-mono">{formatCount(visible)}</strong> of{' '}
          </>
        )}
        <strong className="oe-mono">{formatCount(tracked)}</strong>
        <span className="oe-stats-noun"> objects</span> in orbit
      </span>

      <span className="oe-stats-group">
        <span className="oe-visually-hidden">By object type:</span>
        {OBJECT_TYPES.filter((t) => byType[t] > 0 && t !== 'UNK').map((t) => (
          <span key={t} className="oe-stat">
            <span className="oe-mono">{formatCount(byType[t])}</span> {OBJECT_TYPE_PLURAL[t]}
          </span>
        ))}
      </span>

      <span className="oe-stats-group oe-stats-regimes">
        <span className="oe-visually-hidden">By orbit:</span>
        {ORBIT_REGIMES.map((r) => (
          <span key={r} className="oe-stat" title={REGIME_LABELS[r]}>
            {r} <span className="oe-mono">{formatCount(byRegime[r])}</span>
          </span>
        ))}
      </span>

      {(decayed > 0 || skipped > 0 || generatedAt) && (
        <span className="oe-stats-group oe-stats-meta">
          {decayed > 0 && (
            <span className="oe-stat" title="Catalogued objects that have re-entered the atmosphere">
              <span className="oe-mono">{formatCount(decayed)}</span> re-entered, not shown
            </span>
          )}
          {skipped > 0 && (
            <span className="oe-stat" title="Catalog entries with unusable orbital elements or data">
              <span className="oe-mono">{formatCount(skipped)}</span> without usable orbits
            </span>
          )}
          {generatedAt && (
            <span className={`oe-stat${stale ? ' is-warn' : ''}`} title={`Catalog generated ${generatedAt}`}>
              Updated {formatAge(generatedAt, now)}
            </span>
          )}
        </span>
      )}
    </section>
  )
}

export const StatsBar = memo(StatsBarImpl)
