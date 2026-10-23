# Wiring `src/ui` into App.tsx

All components are presentational: no fetching, typed props, styles in `src/index.css` (`.oe-*`).
Import from `./ui`. Dev preview with sample data: `npx vite` then open `/ui-preview.html` (see `Preview.tsx`, flags `?none ?hover ?ai ?error ?loading ?select=<norad>`).

## Data you build once per catalog version

```ts
const index = useMemo(() => buildSearchIndex(objects), [objects])        // search
const breakdown = useMemo(() => computeBreakdown(objects), [objects])    // stats
const counts = useMemo(() => computeFacetCounts(objects, filters), [objects, filters])
```
`objects: CatalogObject[]` from the engine; `filters: Filters` (start with every category / regime / type).
Use `passesFilters(o, filters)` if the engine needs a per-object visibility test.

## Tree (inside `main.earth-experience`, after the intro, phase === 'main')

```tsx
<div className="app-logo">…</div>                       // unchanged
<StatsBar tracked={breakdown.total} visible={counts.visible} byType={breakdown.byType}
  byRegime={breakdown.byRegime} decayed={catalog.decayed_objects} generatedAt={catalog.generated_at}
  loading={!catalog} />
<Rail filtersOpen={filtersOpen} onFiltersOpenChange={setFiltersOpen} activeFilterCount={n}
  status={error && <>Couldn't load the catalog. <button className="oe-link-btn" onClick={retry}>Retry</button></>}
  search={<SearchBox index={index} onSelect={(o) => select(o.id)} colorFor={categoryColor}
            decayedMatchCount={(q) => /* count of re-entered names matching q, optional */ 0} />}
  filters={<FilterPanel categories={CATEGORIES} filters={filters} counts={counts} onChange={setFilters} />} />
{selected && <SatelliteDetails key={selected.id} object={selected} category={CATEGORY_BY_ID.get(selected.categoryId)}
  getLive={engine.getLiveState /* (id) => LiveState | null, polled at 2 Hz */}
  simTimeMs={time.simTimeMs} following={follow} onFollowChange={setFollow} onClose={clearSelection}
  shareUrl={`${location.origin}/?norad=${selected.norad}`}
  media={details?.media.map(m => ({ label: m.media_type, url: m.url }))} sanitizeUrl={safeExternalUrl}
  loading={detailsLoading} error={detailsError} onRetry={retryDetails} />}
<TimeControls time={time} getSimTimeMs={engine.getSimTimeMs} onPlayPause={…} onWarpChange={…} onNow={…} />
<AIPanel … />                                            // unchanged classes (.ai-launcher, .ai-panel…)
<HoverTooltip ref={tooltipRef} object={hovered} live={hoveredLive} color={hovered && categoryColor(hovered.categoryId)} />
// in the points' onPointerMove:  tooltipRef.current?.setPosition(e.nativeEvent.clientX, e.nativeEvent.clientY)
// and setHovered(obj) only when the hovered id changes.
```

- Remove `ExplorationSidebar`, `SatelliteSearch`, `SatelliteInfoCard`, `.mobile-exploration-bar`; then delete the
  three `LEGACY:` blocks in `index.css`.
- Add `ai-open` to `main.earth-experience` while the assistant is open: details shrink to `--info-max` and the
  clock moves left of the panel. Keep passing `has-satellite-info` to `.ai-panel` as today.
- Phones: the details sheet peeks above the launcher row and the clock; with `ai-open` it sits above the assistant.
- `Rail.status` (catalog loading / error + Retry) stays visible on phones even with filters folded.
- Escape should call `clearSelection` (the close button's title says "Close (Esc)").
- `.earth-controls-hint` re-centres above the clock automatically (CSS `:has(.oe-time)`).

## Per-component notes

| Component | Update rate | Notes |
| --- | --- | --- |
| `HoverTooltip` | pointer moves bypass React | `ref: HoverTooltipHandle` → `setPosition(clientX, clientY)` writes `transform` directly; re-render the parent only when the hovered object (or its live numbers, e.g. 2 Hz) changes. Hidden on `hover: none` devices. |
| `SatelliteDetails` | polls `getLive(id)` every `liveIntervalMs` (500) | `getLive` must be cheap and read the engine's latest frame; do not re-render the parent per frame. Use `key={id}` to reset sheet/copy state. |
| `TimeControls` | 1 Hz | Pass `time` only when it changes (warp/pause/jump). `getSimTimeMs` is optional; without it the face extrapolates `simTimeMs + elapsed * warp`. `warp: 0` = paused; presets live in `DEFAULT_WARP_PRESETS` (lookups). |
| `SearchBox` | per keystroke (deferred) | Renders ≤ `limit` (50) rows; needs ≥2 chars unless digits. `/` focuses it globally. Numeric query = NORAD exact first; `1998-067A`, `98067A`, `067A` match COSPAR. Ties prefer payloads. Pass a stable `onSelect` (useCallback). |
| `FilterPanel` | on filter change | Counts per facet respect the other two facets. |
| `StatsBar` | on catalog change + 1/min | `generatedAt` older than 2 days turns amber. |

Lookups (`ownerName`, `launchSiteLabel`, `OBJECT_TYPE_LABELS`, `REGIME_LABELS`, formatters) are plain functions; reuse them in AI replies or the scene. Note: in CelesTrak SATCAT, Plesetsk is `PLMSC`; `PKMTR` is the Pacific Missile Range Facility (Kauai).
