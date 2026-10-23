/* ============================================================
   FILTER PANEL
   ------------------------------------------------------------
   Three facet groups (category, orbit, object type) as native
   checkboxes inside fieldsets, each with a live count. Counts
   come from computeFacetCounts() so a toggle shows how many
   objects it controls given the other two facets. "Only" on a
   category row isolates it; "Show all" resets every facet.

   When `objects` and `onSelectObject` are passed, each category
   row can expand into a list of its objects (those passing the
   current filters), so a satellite can be picked by browsing a
   category. Lists render in pages; never thousands of rows.
   ============================================================ */

import { memo, useId, useMemo, useState } from 'react'
import type { CatalogObject, Filters, ObjectType, OrbitRegime } from '../engine/contract'
import { passesFilters, type FacetCounts } from './facets'
import { IconChevron } from './icons'
import { OBJECT_TYPES, OBJECT_TYPE_LABELS, ORBIT_REGIMES, REGIME_HINTS, REGIME_LABELS, formatCount } from './lookups'
import type { CategoryInfo } from './types'

const LIST_PAGE = 50

// Payloads first (they're what people look for), then rocket bodies, debris.
const TYPE_ORDER: Readonly<Record<ObjectType, number>> = { PAY: 0, 'R/B': 1, DEB: 2, UNK: 3 }

export interface FilterPanelProps {
  categories: readonly CategoryInfo[]
  filters: Filters
  counts: FacetCounts
  onChange: (next: Filters) => void
  /** Defaults to selecting every category, regime and type. */
  onReset?: () => void
  /** All catalog objects; enables the per-category object lists. */
  objects?: readonly CatalogObject[]
  selectedId?: number | null
  onSelectObject?: (id: number) => void
}

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

function compareForList(a: CatalogObject, b: CatalogObject): number {
  return TYPE_ORDER[a.objectType] - TYPE_ORDER[b.objectType] || a.name.localeCompare(b.name) || a.norad - b.norad
}

/** Objects grouped by category, each group sorted once per catalog. */
function useObjectsByCategory(objects: readonly CatalogObject[] | undefined) {
  return useMemo(() => {
    const groups = new Map<number, CatalogObject[]>()
    if (!objects) return groups
    for (const o of objects) {
      const list = groups.get(o.categoryId)
      if (list) list.push(o)
      else groups.set(o.categoryId, [o])
    }
    for (const list of groups.values()) list.sort(compareForList)
    return groups
  }, [objects])
}

const CategoryObjectList = memo(function CategoryObjectList({
  id,
  category,
  objects,
  filters,
  selectedId,
  onSelect,
}: {
  id: string
  category: CategoryInfo
  objects: readonly CatalogObject[]
  filters: Filters
  selectedId: number | null
  onSelect: (id: number) => void
}) {
  const [limit, setLimit] = useState(LIST_PAGE)
  const visible = useMemo(() => objects.filter((o) => passesFilters(o, filters)), [objects, filters])
  const shown = visible.slice(0, limit)
  const remaining = visible.length - shown.length

  return (
    <div id={id} className="oe-cat-list" role="group" aria-label={`${category.name} objects`}>
      {visible.length === 0 ? (
        <p className="oe-cat-list-empty">No {category.name.toLowerCase()} match the orbit and type filters.</p>
      ) : (
        <ul>
          {shown.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className={`oe-cat-item${o.id === selectedId ? ' is-selected' : ''}`}
                aria-current={o.id === selectedId ? 'true' : undefined}
                onClick={() => onSelect(o.id)}
              >
                <span className="oe-cat-item-name">{o.name}</span>
                <span className="oe-cat-item-id">{o.norad}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {remaining > 0 && (
        <button type="button" className="oe-link-btn oe-cat-more" onClick={() => setLimit((n) => n + LIST_PAGE)}>
          Show {formatCount(Math.min(LIST_PAGE, remaining))} more of {formatCount(remaining)}
        </button>
      )}
    </div>
  )
})

function FilterPanelImpl({
  categories,
  filters,
  counts,
  onChange,
  onReset,
  objects,
  selectedId = null,
  onSelectObject,
}: FilterPanelProps) {
  const listIdBase = useId()
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const byCategory = useObjectsByCategory(objects)
  const listsEnabled = Boolean(objects && onSelectObject)

  const allOn =
    categories.every((c) => filters.categories.has(c.id)) &&
    ORBIT_REGIMES.every((r) => filters.regimes.has(r)) &&
    OBJECT_TYPES.every((t) => filters.types.has(t))

  const reset = () => {
    if (onReset) onReset()
    else
      onChange({
        categories: new Set(categories.map((c) => c.id)),
        regimes: new Set(ORBIT_REGIMES),
        types: new Set(OBJECT_TYPES),
      })
  }

  const setCategory = (id: number) => {
    const turningOn = !filters.categories.has(id)
    onChange({ ...filters, categories: toggled(filters.categories, id) })
    // Ticking a single category on its own is a "show me these" gesture: open its list.
    if (turningOn && filters.categories.size === 0) setExpanded((prev) => new Set(prev).add(id))
  }
  const onlyCategory = (id: number) => {
    onChange({ ...filters, categories: new Set([id]) })
    setExpanded(new Set([id]))
  }
  const toggleExpanded = (id: number) => setExpanded((prev) => toggled(prev, id))
  const setRegime = (r: OrbitRegime) => onChange({ ...filters, regimes: toggled(filters.regimes, r) })
  const setType = (t: ObjectType) => onChange({ ...filters, types: toggled(filters.types, t) })

  return (
    <div className="oe-filters">
      <div className="oe-filters-summary">
        <span>
          Showing <strong className="oe-mono">{formatCount(counts.visible)}</strong> of{' '}
          <span className="oe-mono">{formatCount(counts.total)}</span>
        </span>
        <button type="button" className="oe-link-btn" onClick={reset} disabled={allOn}>
          Show all
        </button>
      </div>

      <fieldset className="oe-facet">
        <legend>Category</legend>
        {categories.map((c) => {
          const on = filters.categories.has(c.id)
          const n = counts.categories.get(c.id) ?? 0
          const open = listsEnabled && on && expanded.has(c.id)
          const listId = `${listIdBase}-cat-${c.id}`
          return (
            <div key={c.id} className="oe-cat-block">
              <div className={`oe-check-row${on ? '' : ' is-off'}${listsEnabled ? ' has-toggle' : ''}`}>
                {listsEnabled && (
                  <button
                    type="button"
                    className={`oe-expand-btn${open ? ' is-open' : ''}`}
                    onClick={() => toggleExpanded(c.id)}
                    disabled={!on || n === 0}
                    aria-expanded={open}
                    aria-controls={open ? listId : undefined}
                    aria-label={`${open ? 'Hide' : 'List'} ${c.name}`}
                    title={on ? `${open ? 'Hide' : 'List'} ${c.name.toLowerCase()}` : `Turn on ${c.name.toLowerCase()} to list them`}
                  >
                    <IconChevron />
                  </button>
                )}
                <label>
                  <input type="checkbox" checked={on} onChange={() => setCategory(c.id)} />
                  <span className="oe-dot" style={{ background: c.color }} aria-hidden="true" />
                  <span className="oe-check-name">{c.name}</span>
                  <span className="oe-count">{formatCount(n)}</span>
                </label>
                <button
                  type="button"
                  className="oe-only-btn"
                  onClick={() => onlyCategory(c.id)}
                  aria-label={`Show only ${c.name}`}
                >
                  Only
                </button>
              </div>
              {open && onSelectObject && (
                <CategoryObjectList
                  id={listId}
                  category={c}
                  objects={byCategory.get(c.id) ?? []}
                  filters={filters}
                  selectedId={selectedId}
                  onSelect={onSelectObject}
                />
              )}
            </div>
          )
        })}
      </fieldset>

      <fieldset className="oe-facet">
        <legend>Orbit</legend>
        <div className="oe-chip-grid">
          {ORBIT_REGIMES.map((r) => {
            const on = filters.regimes.has(r)
            return (
              <label key={r} className={`oe-chip${on ? ' is-on' : ''}`} title={REGIME_HINTS[r]}>
                <input type="checkbox" checked={on} onChange={() => setRegime(r)} />
                <span className="oe-chip-code">{r}</span>
                <span className="oe-count">{formatCount(counts.regimes[r])}</span>
                <span className="oe-visually-hidden">{REGIME_LABELS[r]}</span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <fieldset className="oe-facet">
        <legend>Object type</legend>
        {OBJECT_TYPES.map((t) => {
          const on = filters.types.has(t)
          return (
            <div key={t} className={`oe-check-row${on ? '' : ' is-off'}`}>
              <label>
                <input type="checkbox" checked={on} onChange={() => setType(t)} />
                <span className="oe-check-name">{OBJECT_TYPE_LABELS[t]}</span>
                <span className="oe-count">{formatCount(counts.types[t])}</span>
              </label>
            </div>
          )
        })}
      </fieldset>
    </div>
  )
}

export const FilterPanel = memo(FilterPanelImpl)
