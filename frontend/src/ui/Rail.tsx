/* ============================================================
   LEFT RAIL (layout shell)
   ------------------------------------------------------------
   Desktop: a fixed column under the logo with search on top and
   the filter panel scrolling below it.
   Phones (<=720px): search stays visible as a top bar; filters
   fold behind the "Filters" toggle and open as a sheet beneath it.
   ============================================================ */

import { useId } from 'react'
import type { ReactNode } from 'react'
import { IconFilters } from './icons'

export interface RailProps {
  search: ReactNode
  filters: ReactNode
  /** Phone only: whether the filter sheet is open. */
  filtersOpen: boolean
  onFiltersOpenChange: (open: boolean) => void
  /** Number of facets narrowed from "all"; shown on the phone toggle. */
  activeFilterCount?: number
  /** Status line under search (loading / error + retry). */
  status?: ReactNode
}

export function Rail({ search, filters, filtersOpen, onFiltersOpenChange, activeFilterCount = 0, status }: RailProps) {
  const sheetId = useId()
  return (
    <nav className={`oe-panel oe-rail${filtersOpen ? ' filters-open' : ''}`} aria-label="Find and filter objects">
      <div className="oe-rail-top">
        {search}
        <button
          type="button"
          className={`oe-btn oe-rail-toggle${activeFilterCount ? ' is-on' : ''}`}
          aria-expanded={filtersOpen}
          aria-controls={sheetId}
          onClick={() => onFiltersOpenChange(!filtersOpen)}
        >
          <IconFilters />
          <span className="oe-visually-hidden">Filters</span>
          {activeFilterCount > 0 && <span className="oe-rail-toggle-count">{activeFilterCount}</span>}
        </button>
      </div>
      {status && <div className="oe-rail-status">{status}</div>}
      <div id={sheetId} className="oe-rail-body">
        {filters}
      </div>
    </nav>
  )
}
