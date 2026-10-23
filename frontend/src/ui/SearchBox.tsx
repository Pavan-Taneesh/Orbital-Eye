/* ============================================================
   SEARCH BOX
   ------------------------------------------------------------
   Instant search over the in-memory catalog (see search.ts).
   ARIA combobox + listbox: Up/Down move, Enter picks, Escape
   clears then blurs, "/" focuses from anywhere. Typing stays
   responsive because results are computed from a deferred copy
   of the query and at most `limit` rows are ever rendered.
   ============================================================ */

import { memo, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { CatalogObject } from '../engine/contract'
import { IconClose, IconSearch } from './icons'
import { OBJECT_TYPE_LABELS, formatCount } from './lookups'
import { searchCatalog } from './search'
import type { SearchHit, SearchIndex } from './search'

export interface SearchBoxProps {
  index: SearchIndex
  onSelect: (object: CatalogObject) => void
  /** Category id -> data colour for the result dots. */
  colorFor?: (categoryId: number) => string
  /** How many re-entered (not shown) objects match this query. */
  decayedMatchCount?: (query: string) => number
  limit?: number
  placeholder?: string
  /** Global key that focuses the input; null disables it. */
  shortcutKey?: string | null
  autoFocus?: boolean
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

const ResultRow = memo(function ResultRow({
  hit,
  id,
  active,
  color,
  onPick,
  onHover,
  index,
}: {
  hit: SearchHit
  id: string
  active: boolean
  color: string
  onPick: (o: CatalogObject) => void
  onHover: (i: number) => void
  index: number
}) {
  const o = hit.object
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      className={`oe-result${active ? ' is-active' : ''}`}
      // mousedown keeps focus in the input; click would blur first
      onMouseDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        onPick(o)
      }}
      onMouseMove={() => {
        if (!active) onHover(index)
      }}
    >
      <span className="oe-dot" style={{ background: color }} aria-hidden="true" />
      <span className="oe-result-name">{o.name}</span>
      <span className="oe-result-type">{OBJECT_TYPE_LABELS[o.objectType]}</span>
      <span className="oe-result-ids oe-mono">
        <span className={hit.field === 'norad' ? 'is-match' : undefined}>{o.norad}</span>
        {o.cospar && <span className={hit.field === 'cospar' ? 'is-match' : undefined}>{o.cospar}</span>}
      </span>
    </li>
  )
})

function SearchBoxImpl({
  index,
  onSelect,
  colorFor,
  decayedMatchCount,
  limit = 50,
  placeholder = 'Name, NORAD or COSPAR ID',
  shortcutKey = '/',
  autoFocus = false,
}: SearchBoxProps) {
  const baseId = useId()
  const listId = `${baseId}-list`
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const deferred = useDeferredValue(query)

  const result = useMemo(() => searchCatalog(index, deferred, limit), [index, deferred, limit])
  const trimmed = deferred.trim()
  const decayed = useMemo(
    () => (trimmed && decayedMatchCount ? decayedMatchCount(trimmed) : 0),
    [trimmed, decayedMatchCount],
  )

  const showList = open && trimmed.length > 0
  const activeIndex = Math.min(active, Math.max(0, result.hits.length - 1))
  const activeId = showList && result.hits.length ? `${baseId}-opt-${activeIndex}` : undefined

  useEffect(() => {
    if (!shortcutKey) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== shortcutKey || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcutKey])

  // Keep the highlighted option in view while arrowing through the list.
  useEffect(() => {
    if (!activeId) return
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const pick = useCallback(
    (o: CatalogObject) => {
      onSelect(o)
      setQuery('')
      setOpen(false)
      setActive(0)
    },
    [onSelect],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = result.hits.length
    switch (e.key) {
      case 'ArrowDown':
        if (!n) return
        e.preventDefault()
        setOpen(true)
        setActive((activeIndex + 1) % n)
        break
      case 'ArrowUp':
        if (!n) return
        e.preventDefault()
        setOpen(true)
        setActive((activeIndex - 1 + n) % n)
        break
      case 'Enter':
        if (showList && n) {
          e.preventDefault()
          pick(result.hits[activeIndex].object)
        }
        break
      case 'Escape':
        e.preventDefault()
        if (query) {
          setQuery('')
          setActive(0)
        } else {
          inputRef.current?.blur()
        }
        break
      default:
        break
    }
  }

  const stale = query !== deferred
  const tooShort = trimmed.length < 2 && !/^\d$/.test(trimmed)
  const summary = !showList
    ? ''
    : tooShort
      ? 'Type at least 2 characters, or a NORAD ID.'
      : result.total === 0
        ? `Nothing in orbit matches “${trimmed}”.`
        : result.total > result.hits.length
          ? `Top ${result.hits.length} of ${formatCount(result.total)} matches. Keep typing to narrow.`
          : `${formatCount(result.total)} match${result.total === 1 ? '' : 'es'}`
  const decayedNote =
    showList && !tooShort && decayed > 0
      ? decayed === 1
        ? '1 re-entered object also matches; it has left orbit and is not shown.'
        : `${formatCount(decayed)} re-entered objects also match; they have left orbit and are not shown.`
      : ''
  const color = colorFor ?? (() => 'var(--text-dim)')

  return (
    <div className="oe-search" role="search">
      <div className="oe-search-field">
        <IconSearch />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search the catalog"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={100}
          placeholder={placeholder}
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <button
            type="button"
            className="oe-icon-btn oe-search-clear"
            aria-label="Clear search"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            <IconClose />
          </button>
        ) : (
          shortcutKey && (
            <kbd className="oe-kbd" aria-hidden="true">
              {shortcutKey}
            </kbd>
          )
        )}
      </div>

      {/* Persistent live region: announced even though the popup itself mounts and hides. */}
      <span className="oe-visually-hidden" aria-live="polite" aria-atomic="true">
        {stale ? '' : `${summary} ${decayedNote}`.trim()}
      </span>

      <div
        className={`oe-search-pop${showList ? ' is-open' : ''}${stale ? ' is-stale' : ''}`}
        hidden={!showList}
        // Keeps focus in the input, so clicking or dragging the scrollbar never closes the list.
        onMouseDown={(e) => e.preventDefault()}
      >
        <ul id={listId} role="listbox" aria-label="Search results" className="oe-results">
          {showList &&
            result.hits.map((hit, i) => (
              <ResultRow
                key={hit.object.id}
                id={`${baseId}-opt-${i}`}
                index={i}
                hit={hit}
                active={i === activeIndex}
                color={color(hit.object.categoryId)}
                onPick={pick}
                onHover={setActive}
              />
            ))}
        </ul>
        {showList && (
          <div className="oe-search-foot">
            <span>{summary}</span>
            {decayedNote && <span className="oe-search-decayed">{decayedNote}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

export const SearchBox = memo(SearchBoxImpl)
