/* ============================================================
   FILTER FACETS (pure)
   ------------------------------------------------------------
   Counts for the filter panel and the stats bar in one pass.
   Each facet's count respects the *other* two facets, so a
   toggle always shows how many objects it would add or remove.
   ============================================================ */

import type { CatalogObject, Filters, ObjectType, OrbitRegime } from '../engine/contract'

export interface FacetCounts {
  readonly categories: ReadonlyMap<number, number>
  readonly regimes: Readonly<Record<OrbitRegime, number>>
  readonly types: Readonly<Record<ObjectType, number>>
  /** Objects passing all three filters. */
  readonly visible: number
  /** All objects, unfiltered. */
  readonly total: number
}

export interface CatalogBreakdown {
  readonly total: number
  readonly byType: Readonly<Record<ObjectType, number>>
  readonly byRegime: Readonly<Record<OrbitRegime, number>>
}

const zeroRegimes = (): Record<OrbitRegime, number> => ({ LEO: 0, MEO: 0, GEO: 0, HEO: 0 })
const zeroTypes = (): Record<ObjectType, number> => ({ PAY: 0, 'R/B': 0, DEB: 0, UNK: 0 })

export function computeFacetCounts(objects: readonly CatalogObject[], filters: Filters): FacetCounts {
  const categories = new Map<number, number>()
  const regimes = zeroRegimes()
  const types = zeroTypes()
  let visible = 0

  for (const o of objects) {
    const c = filters.categories.has(o.categoryId)
    const r = filters.regimes.has(o.regime)
    const t = filters.types.has(o.objectType)
    if (r && t) categories.set(o.categoryId, (categories.get(o.categoryId) ?? 0) + 1)
    if (c && t) regimes[o.regime] += 1
    if (c && r) types[o.objectType] += 1
    if (c && r && t) visible += 1
  }

  return { categories, regimes, types, visible, total: objects.length }
}

export function computeBreakdown(objects: readonly CatalogObject[]): CatalogBreakdown {
  const byType = zeroTypes()
  const byRegime = zeroRegimes()
  for (const o of objects) {
    byType[o.objectType] += 1
    byRegime[o.regime] += 1
  }
  return { total: objects.length, byType, byRegime }
}

export function passesFilters(o: CatalogObject, filters: Filters): boolean {
  return filters.categories.has(o.categoryId) && filters.regimes.has(o.regime) && filters.types.has(o.objectType)
}
