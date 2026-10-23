/* ============================================================
   UI PREVIEW (dev only, served at /ui-preview.html)
   ------------------------------------------------------------
   Renders every src/ui component with realistic sample data over
   a static dark backdrop, without the 3D scene. Query flags:
     ?select=<norad>   preselect an object (default 25544)
     ?none             nothing selected
     ?ai               simulate the assistant panel being open
     ?error            details error state   ?loading  loading state
     ?hover            pin the tooltip in the middle of the screen
   ============================================================ */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { CatalogObject, Filters, LiveState, ObjectType, OrbitRegime, TimeState } from '../engine/contract'
import { FilterPanel } from './FilterPanel'
import { HoverTooltip } from './HoverTooltip'
import type { HoverTooltipHandle } from './HoverTooltip'
import { Rail } from './Rail'
import { SatelliteDetails } from './SatelliteDetails'
import { SearchBox } from './SearchBox'
import { StatsBar } from './StatsBar'
import { TimeControls } from './TimeControls'
import { computeBreakdown, computeFacetCounts, passesFilters } from './facets'
import { OBJECT_TYPES, ORBIT_REGIMES } from './lookups'
import { buildSearchIndex, normalizeText } from './search'
import type { CategoryInfo } from './types'

const CATEGORIES: CategoryInfo[] = [
  { id: 1, name: 'Space stations', color: '#6fff9f' },
  { id: 2, name: 'Navigation', color: '#ffcf4f' },
  { id: 3, name: 'Communication', color: '#4fd3ff' },
  { id: 4, name: 'Weather', color: '#ff6f91' },
  { id: 5, name: 'Scientific', color: '#b58bff' },
  { id: 6, name: 'Rocket bodies', color: '#ff9b54' },
  { id: 7, name: 'Debris', color: '#8d99ae' },
]
const COLOR = new Map(CATEGORIES.map((c) => [c.id, c.color]))
const colorFor = (id: number) => COLOR.get(id) ?? '#ffffff'

const NOW = Date.UTC(2026, 9, 23, 14, 5, 9)
const T0 = performance.now()
const GENERATED_AT = new Date(Date.now() - 3 * 3_600_000).toISOString()
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

function obj(o: Omit<CatalogObject, 'id'> & { id?: number }): CatalogObject {
  return { id: o.id ?? o.norad, ...o }
}

const FEATURED: CatalogObject[] = [
  obj({
    norad: 25544, name: 'ISS (ZARYA)', cospar: '1998-067A', categoryId: 1, objectType: 'PAY', owner: 'ISS',
    launchDate: '1998-11-20', launchSite: 'TYMSC', rcs: 399.05, epoch: daysAgo(0.3), periodMin: 92.9,
    inclinationDeg: 51.64, apogeeKm: 423, perigeeKm: 416, eccentricity: 0.00049, regime: 'LEO',
  }),
  obj({
    norad: 44713, name: 'STARLINK-1007', cospar: '2019-074A', categoryId: 3, objectType: 'PAY', owner: 'US',
    launchDate: '2019-11-11', launchSite: 'AFETR', rcs: null, epoch: daysAgo(0.8), periodMin: 95.6,
    inclinationDeg: 53.05, apogeeKm: 551, perigeeKm: 548, eccentricity: 0.00014, regime: 'LEO',
  }),
  obj({
    norad: 43011, name: 'CZ-4B R/B', cospar: '2017-077D', categoryId: 6, objectType: 'R/B', owner: 'PRC',
    launchDate: '2017-11-21', launchSite: 'TSC', rcs: 5.91, epoch: daysAgo(2.1), periodMin: 100.4,
    inclinationDeg: 98.62, apogeeKm: 884, perigeeKm: 681, eccentricity: 0.0144, regime: 'LEO',
  }),
  obj({
    norad: 29756, name: 'FENGYUN 1C DEB', cospar: '1999-025EAQ', categoryId: 7, objectType: 'DEB', owner: 'PRC',
    launchDate: '1999-05-10', launchSite: 'TSC', rcs: 0.021, epoch: daysAgo(11.4), periodMin: 102.3,
    inclinationDeg: 98.91, apogeeKm: 1102, perigeeKm: 791, eccentricity: 0.0219, regime: 'LEO',
  }),
  obj({
    norad: 26824, name: 'INTELSAT 901 (IS-901)', cospar: '2001-024A', categoryId: 3, objectType: 'PAY',
    owner: 'ITSO', launchDate: '2001-06-09', launchSite: 'FRGUI', rcs: 18.4, epoch: daysAgo(1.2),
    periodMin: 1436.1, inclinationDeg: 0.02, apogeeKm: 35_801, perigeeKm: 35_772, eccentricity: 0.00034,
    regime: 'GEO',
  }),
  obj({
    norad: 36585, name: 'GPS BIIF-1 (PRN 25)', cospar: '2010-022A', categoryId: 2, objectType: 'PAY', owner: 'US',
    launchDate: '2010-05-28', launchSite: 'AFETR', rcs: 3.2, epoch: daysAgo(0.9), periodMin: 717.9,
    inclinationDeg: 55.2, apogeeKm: 20_340, perigeeKm: 20_020, eccentricity: 0.0079, regime: 'MEO',
  }),
  obj({
    norad: 40296, name: 'MOLNIYA 2-10', cospar: '1971-100A', categoryId: 2, objectType: 'PAY', owner: 'CIS',
    launchDate: '1971-12-27', launchSite: 'PLMSC', rcs: 7.8, epoch: daysAgo(3.4), periodMin: 717.4,
    inclinationDeg: 64.1, apogeeKm: 39_500, perigeeKm: 1_050, eccentricity: 0.73, regime: 'HEO',
  }),
]

/** ~5,500 plausible filler objects so search, counts and scrolling are tested at scale. */
function synthCatalog(): CatalogObject[] {
  const out = [...FEATURED]
  let norad = 50_000
  const push = (n: number, f: (i: number) => Omit<CatalogObject, 'id' | 'norad' | 'epoch'>) => {
    for (let i = 0; i < n; i += 1) {
      norad += 1
      out.push({ id: norad, norad, epoch: daysAgo((i % 13) * 0.7), ...f(i) })
    }
  }
  push(3000, (i) => ({
    name: `STARLINK-${2000 + i}`, cospar: `20${20 + (i % 6)}-0${10 + (i % 80)}${'ABCDEFGH'[i % 8]}`, categoryId: 3,
    objectType: 'PAY', owner: 'US', launchDate: `20${20 + (i % 6)}-03-1${i % 9}`, launchSite: i % 3 ? 'AFETR' : 'AFWTR',
    rcs: null, periodMin: 95.5, inclinationDeg: 53, apogeeKm: 550, perigeeKm: 545, eccentricity: 0.0001, regime: 'LEO',
  }))
  push(1300, (i) => ({
    name: i % 2 ? 'FENGYUN 1C DEB' : 'COSMOS 2251 DEB', cospar: `1999-025${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i >> 3) % 26))}`,
    categoryId: 7, objectType: 'DEB', owner: i % 2 ? 'PRC' : 'CIS', launchDate: '1999-05-10', launchSite: 'TSC',
    rcs: 0.05, periodMin: 101, inclinationDeg: 98.8, apogeeKm: 950, perigeeKm: 780, eccentricity: 0.012, regime: 'LEO',
  }))
  push(650, (i) => ({
    name: i % 3 ? 'SL-16 R/B' : 'CZ-2C R/B', cospar: `19${80 + (i % 19)}-0${10 + (i % 80)}B`, categoryId: 6,
    objectType: 'R/B', owner: i % 3 ? 'CIS' : 'PRC', launchDate: `19${80 + (i % 19)}-06-01`, launchSite: i % 3 ? 'TYMSC' : 'JSC',
    rcs: 8, periodMin: 104, inclinationDeg: 71, apogeeKm: 850, perigeeKm: 830, eccentricity: 0.001, regime: 'LEO',
  }))
  push(420, (i) => ({
    name: `${['INTELSAT', 'SES', 'EUTELSAT', 'ASTRA', 'GALAXY', 'TDRS'][i % 6]} ${i + 1}`, cospar: `20${10 + (i % 15)}-0${10 + (i % 60)}A`,
    categoryId: 3, objectType: 'PAY', owner: ['ITSO', 'SES', 'EUTE', 'SES', 'US', 'US'][i % 6], launchDate: '2015-01-01',
    launchSite: 'FRGUI', rcs: 12, periodMin: 1436, inclinationDeg: 0.05, apogeeKm: 35_790, perigeeKm: 35_780,
    eccentricity: 0.0002, regime: 'GEO',
  }))
  push(110, (i) => ({
    name: `${['NAVSTAR', 'GALILEO', 'BEIDOU-3', 'COSMOS (GLONASS)'][i % 4]} ${i + 1}`, cospar: '2018-001A', categoryId: 2,
    objectType: 'PAY', owner: ['US', 'ESA', 'PRC', 'CIS'][i % 4], launchDate: '2018-01-01', launchSite: 'AFETR',
    rcs: 3, periodMin: 718, inclinationDeg: 55, apogeeKm: 20_200, perigeeKm: 20_180, eccentricity: 0.001, regime: 'MEO',
  }))
  push(60, (i) => ({
    name: `NOAA ${15 + (i % 6)}`, cospar: '2005-018A', categoryId: 4, objectType: 'PAY', owner: 'US',
    launchDate: '2005-05-20', launchSite: 'AFWTR', rcs: 4, periodMin: 101.2, inclinationDeg: 99, apogeeKm: 860,
    perigeeKm: 840, eccentricity: 0.0013, regime: 'LEO',
  }))
  push(40, (i) => ({
    name: `OBJECT ${String.fromCharCode(65 + (i % 26))}`, cospar: '2024-200A', categoryId: 5, objectType: 'UNK', owner: 'TBD',
    launchDate: '2024-10-01', launchSite: 'JSC', rcs: 0.3, periodMin: 96, inclinationDeg: 41, apogeeKm: 600,
    perigeeKm: 580, eccentricity: 0.0015, regime: 'LEO',
  }))
  return out
}

const DECAYED_NAMES = ['STARLINK-1007 (DECAYED TWIN)', 'FENGYUN 1C DEB', 'SKYLAB', 'MIR', 'TIANGONG-1', 'STARLINK-1130']
  .map(normalizeText)

function allFilters(): Filters {
  return {
    categories: new Set(CATEGORIES.map((c) => c.id)),
    regimes: new Set<OrbitRegime>(ORBIT_REGIMES),
    types: new Set<ObjectType>(OBJECT_TYPES),
  }
}

function fakeLive(o: CatalogObject, simMs: number): LiveState {
  const phase = ((simMs / 60_000) / o.periodMin) * Math.PI * 2 + o.norad
  const a = (o.apogeeKm + o.perigeeKm) / 2
  const altitudeKm = a + ((o.apogeeKm - o.perigeeKm) / 2) * Math.cos(phase)
  const r = 6378 + altitudeKm
  const speedKmS = Math.sqrt(398_600.4418 * (2 / r - 1 / (6378 + a)))
  return {
    altitudeKm,
    speedKmS,
    latDeg: o.inclinationDeg > 90 ? (180 - o.inclinationDeg) * Math.sin(phase) : o.inclinationDeg * Math.sin(phase),
    lonDeg: ((phase * 57.2958 - simMs / 240_000) % 360) - 180,
  }
}

export function Preview() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const catalog = useMemo(() => synthCatalog(), [])
  const index = useMemo(() => buildSearchIndex(catalog), [catalog])
  const breakdown = useMemo(() => computeBreakdown(catalog), [catalog])
  const [filters, setFilters] = useState<Filters>(allFilters)
  const counts = useMemo(() => computeFacetCounts(catalog, filters), [catalog, filters])
  const [filtersOpen, setFiltersOpen] = useState(false)

  const initialNorad = params.has('none') ? null : Number(params.get('select') ?? 25544)
  const [selected, setSelected] = useState<CatalogObject | null>(
    () => catalog.find((o) => o.norad === initialNorad) ?? null,
  )
  const [following, setFollowing] = useState(false)
  // Only the hovered object is state; pointer moves go to the tooltip's imperative handle.
  const tooltip = useRef<HoverTooltipHandle>(null)
  const [hover, setHover] = useState<CatalogObject | null>(() => (params.has('hover') ? FEATURED[2] : null))
  const pinTooltip = useCallback((handle: HoverTooltipHandle | null) => {
    tooltip.current = handle
    if (handle && params.has('hover')) handle.setPosition(window.innerWidth / 2, window.innerHeight / 2)
  }, [params]
  )

  // Fake engine clock: sim = base + elapsed * warp.
  const [time, setTime] = useState<TimeState>({ simTimeMs: NOW, warp: 1, live: true })
  const clock = useRef({ base: NOW, start: T0, warp: 1, lastWarp: 1 })
  const getSimTimeMs = useCallback(() => {
    const c = clock.current
    return c.base + (performance.now() - c.start) * c.warp
  }, [])
  const setWarp = (warp: number, live = false) => {
    const sim = getSimTimeMs()
    clock.current = { base: live ? NOW : sim, start: performance.now(), warp, lastWarp: warp || clock.current.lastWarp }
    setTime({ simTimeMs: live ? NOW : sim, warp, live })
  }

  const getLive = useCallback(
    (id: number) => {
      const o = catalog.find((c) => c.id === id)
      return o ? fakeLive(o, getSimTimeMs()) : null
    },
    [catalog, getSimTimeMs],
  )

  const activeFilterCount =
    (filters.categories.size < CATEGORIES.length ? 1 : 0) +
    (filters.regimes.size < ORBIT_REGIMES.length ? 1 : 0) +
    (filters.types.size < OBJECT_TYPES.length ? 1 : 0)

  const decayedMatchCount = useCallback((q: string) => {
    const n = normalizeText(q)
    return DECAYED_NAMES.filter((d) => d.includes(n)).length * 700
  }, [])

  const visibleSample = useMemo(() => FEATURED.filter((o) => passesFilters(o, filters)), [filters])

  return (
    <main
      className={`earth-experience is-main${params.has('ai') ? ' ai-open' : ''}`}
      onPointerMove={(e) => {
        const target = e.target as HTMLElement
        if (!target.classList.contains('pv-stage') && !target.classList.contains('pv-sat')) {
          if (hover && !params.has('hover')) setHover(null)
          return
        }
        const idx = Number(target.dataset.idx ?? -1)
        const o = idx >= 0 ? visibleSample[idx] : null
        if (o) {
          if (o !== hover) setHover(o)
          tooltip.current?.setPosition(e.clientX, e.clientY)
        }
        else if (hover && !params.has('hover')) setHover(null)
      }}
    >
      <div className="pv-stage">
        <div className="pv-earth" />
        {visibleSample.map((o, i) => (
          <button
            key={o.id}
            type="button"
            className="pv-sat"
            data-idx={i}
            aria-label={`Select ${o.name}`}
            style={{ left: `${30 + ((i * 37) % 45)}%`, top: `${22 + ((i * 23) % 55)}%`, background: colorFor(o.categoryId) }}
            onClick={() => setSelected(o)}
          />
        ))}
      </div>

      <div className="app-logo">
        <span className="app-logo-eye" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <circle className="eye-ring eye-ring-outer" cx="12" cy="12" r="10.5" />
            <circle className="eye-ring" cx="12" cy="12" r="7" />
            <circle className="eye-pupil" cx="12" cy="12" r="2.1" />
            <circle className="eye-orbiter" cx="19" cy="12" r="1.1" />
          </svg>
        </span>
        <span>ORBITAL&nbsp;EYE</span>
      </div>

      <StatsBar
        tracked={breakdown.total}
        visible={counts.visible}
        byType={breakdown.byType}
        byRegime={breakdown.byRegime}
        decayed={4518}
        generatedAt={GENERATED_AT}
      />

      <Rail
        filtersOpen={filtersOpen}
        onFiltersOpenChange={setFiltersOpen}
        activeFilterCount={activeFilterCount}
        search={
          <SearchBox
            index={index}
            colorFor={colorFor}
            decayedMatchCount={decayedMatchCount}
            onSelect={(o) => {
              setSelected(o)
              setFiltersOpen(false)
            }}
          />
        }
        filters={<FilterPanel categories={CATEGORIES} filters={filters} counts={counts} onChange={setFilters} />}
      />

      {selected && (
        <SatelliteDetails
          key={selected.id}
          object={selected}
          category={CATEGORIES.find((c) => c.id === selected.categoryId)}
          getLive={getLive}
          simTimeMs={time.simTimeMs}
          following={following}
          onFollowChange={setFollowing}
          onClose={() => setSelected(null)}
          shareUrl={`${window.location.origin}/?norad=${selected.norad}`}
          loading={params.has('loading')}
          error={params.has('error') ? "Couldn't load mission details." : null}
          onRetry={() => undefined}
          description={
            selected.norad === 25544
              ? 'A modular space station in low Earth orbit, continuously crewed since November 2000.'
              : null
          }
          media={
            selected.norad === 25544
              ? [
                  { label: 'NASA station page', url: 'https://www.nasa.gov/international-space-station/' },
                  { label: 'Bad link (hidden)', url: 'javascript:alert(1)' },
                ]
              : undefined
          }
        />
      )}

      <TimeControls
        time={time}
        getSimTimeMs={getSimTimeMs}
        onPlayPause={() => setWarp(time.warp === 0 ? clock.current.lastWarp : 0)}
        onWarpChange={(w) => setWarp(w)}
        onNow={() => setWarp(1, true)}
      />

      <button type="button" className="ai-launcher" aria-label="Open AI assistant">
        <span className="ai-launcher-orb" />
        <span className="ai-launcher-copy">
          <span className="ai-launcher-title">AI assistant</span>
          <span className="ai-launcher-prompt">Ask about satellites</span>
        </span>
      </button>

      <div className="earth-controls-hint">Drag to rotate · Scroll to zoom</div>

      <HoverTooltip
        ref={pinTooltip}
        object={hover}
        live={hover ? fakeLive(hover, time.simTimeMs) : null}
        color={hover ? colorFor(hover.categoryId) : undefined}
      />
    </main>
  )
}
