/* ============================================================
   SATELLITE DETAILS PANEL
   ------------------------------------------------------------
   Right-hand panel on desktop, bottom sheet on phones. Static
   facts come from CatalogObject; live telemetry is pulled from
   `getLive` twice a second so the parent never re-renders per
   frame. All dates/ages are relative to the simulation clock
   passed in `simTimeMs`, except data age which uses wall time.
   ============================================================ */

import { memo, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { CatalogObject, LiveState } from '../engine/contract'
import { usePolled, useWallClock } from './hooks'
import { IconCheck, IconClose, IconExternal, IconLink, IconTarget } from './icons'
import {
  OBJECT_TYPE_LABELS,
  REGIME_HINTS,
  REGIME_LABELS,
  STALE_EPOCH_DAYS,
  ageDays,
  formatAge,
  formatDate,
  formatDeg,
  formatEccentricity,
  formatKm,
  formatLat,
  formatLon,
  formatPeriod,
  formatSpeed,
  formatTimeInOrbit,
  launchSiteLabel,
  ownerName,
  rcsLabel,
} from './lookups'
import type { CategoryInfo, MediaLink } from './types'

export interface SatelliteDetailsProps {
  object: CatalogObject
  category?: CategoryInfo
  /** Returns the object's live state; polled every `liveIntervalMs`. */
  getLive?: (id: number) => LiveState | null
  liveIntervalMs?: number
  /** Current simulated UTC (epoch ms), for "time in orbit". */
  simTimeMs: number

  following: boolean
  onFollowChange: (next: boolean) => void
  onClose: () => void
  /** Absolute URL that reopens this object (e.g. `?norad=25544`). Omit to hide Copy link. */
  shareUrl?: string

  /** Optional enrichment (fetched by the integrator). */
  media?: readonly MediaLink[]
  description?: string | null
  /** Returns a safe absolute URL or null; defaults to an http/https check. */
  sanitizeUrl?: (raw: string) => string | null
  loading?: boolean
  error?: string | null
  onRetry?: () => void
}

function defaultSanitize(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** Clipboard API when available (secure contexts), else a hidden-textarea copy. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

const sameLive = (a: LiveState | null, b: LiveState | null) =>
  a === b ||
  (!!a &&
    !!b &&
    Math.round(a.altitudeKm) === Math.round(b.altitudeKm) &&
    Math.round(a.speedKmS * 100) === Math.round(b.speedKmS * 100) &&
    Math.round(a.latDeg * 100) === Math.round(b.latDeg * 100) &&
    Math.round(a.lonDeg * 100) === Math.round(b.lonDeg * 100))

/**
 * Per-object pages on reference sites, keyed by NORAD ID so each link lands on
 * this object, not a home page. (NASA NSSDCA is left out: it lacks many objects,
 * including the ISS and Hubble, and shows an error page for them.)
 */
function referenceLinks(object: CatalogObject): { label: string; href: string; hint: string }[] {
  const norad = encodeURIComponent(String(object.norad))
  const links = [
    { label: 'N2YO', href: `https://www.n2yo.com/satellite/?s=${norad}`, hint: 'Live tracking and passes' },
    {
      label: 'Heavens-Above',
      href: `https://www.heavens-above.com/SatInfo.aspx?satid=${norad}`,
      hint: 'When to see it from where you are',
    },
    {
      label: 'CelesTrak',
      href: `https://celestrak.org/satcat/table-satcat.php?CATNR=${norad}`,
      hint: 'Official catalog record',
    },
  ]
  // Encyclopedia articles exist for spacecraft, rarely for individual debris or stages.
  if (object.objectType === 'PAY') {
    links.push({
      label: 'Wikipedia',
      href: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(`${object.name} satellite`)}`,
      hint: 'Background and mission history',
    })
  }
  return links
}

function Row({ label, value, title, mono = false }: { label: string; value: string; title?: string; mono?: boolean }) {
  return (
    <div className="oe-row" title={title}>
      <dt>{label}</dt>
      <dd className={mono ? 'oe-mono' : undefined}>{value}</dd>
    </div>
  )
}

function Telemetry({
  id,
  getLive,
  intervalMs,
}: {
  id: number
  getLive?: (id: number) => LiveState | null
  intervalMs: number
}) {
  const read = getLive ? () => getLive(id) : undefined
  const live = usePolled<LiveState | null>(read, intervalMs, id, sameLive) ?? null

  return (
    <section className="oe-telemetry" aria-label="Live position">
      <dl>
        <div>
          <dt>Altitude</dt>
          <dd>{live ? formatKm(live.altitudeKm) : '—'}</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{live ? formatSpeed(live.speedKmS) : '—'}</dd>
        </div>
        <div>
          <dt>Latitude</dt>
          <dd>{live ? formatLat(live.latDeg) : '—'}</dd>
        </div>
        <div>
          <dt>Longitude</dt>
          <dd>{live ? formatLon(live.lonDeg) : '—'}</dd>
        </div>
      </dl>
      {!live && getLive && <p className="oe-note">Waiting for a position…</p>}
    </section>
  )
}

function SatelliteDetailsImpl({
  object,
  category,
  getLive,
  liveIntervalMs = 500,
  simTimeMs,
  following,
  onFollowChange,
  onClose,
  shareUrl,
  media,
  description,
  sanitizeUrl = defaultSanitize,
  loading = false,
  error = null,
  onRetry,
}: SatelliteDetailsProps) {
  const titleId = useId()
  const wallNow = useWallClock(60_000)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  const copyLink = async () => {
    if (!shareUrl) return
    const ok = await copyText(shareUrl)
    setCopied(ok ? 'done' : 'failed')
    window.clearTimeout(copyTimer.current)
    if (ok) copyTimer.current = window.setTimeout(() => setCopied('idle'), 1800)
  }

  const epochDays = ageDays(object.epoch, wallNow)
  const stale = epochDays !== null && epochDays > STALE_EPOCH_DAYS
  const mediaLinks = (media ?? [])
    .map((m) => ({ label: m.label, href: sanitizeUrl(m.url), hint: undefined as string | undefined }))
    .filter((m): m is { label: string; href: string; hint: undefined } => m.href !== null)
    .slice(0, 4)
  const links = [...referenceLinks(object), ...mediaLinks]

  return (
    <aside
      className={`oe-panel oe-details${expanded ? ' is-expanded' : ''}`}
      aria-labelledby={titleId}
      style={{ '--cat': category?.color ?? 'var(--text-dim)' } as CSSProperties}
    >
      <button
        type="button"
        className="oe-sheet-handle"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse details' : 'Expand details'}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="oe-sheet-grip" />
      </button>

      <header className="oe-details-head">
        <div className="oe-details-title">
          <h2 id={titleId}>{object.name}</h2>
          <p className="oe-details-sub">
            <span className="oe-dot" aria-hidden="true" />
            <span>{category?.name ?? 'Uncategorized'}</span>
            <span className="oe-badge">{OBJECT_TYPE_LABELS[object.objectType]}</span>
          </p>
          <p className="oe-details-ids oe-mono">
            <span>
              <abbr title="NORAD catalog number">NORAD</abbr> {object.norad}
            </span>
            {object.cospar && (
              <span>
                <abbr title="International designator">COSPAR</abbr> {object.cospar}
              </span>
            )}
          </p>
        </div>
        <button type="button" className="oe-icon-btn" onClick={onClose} aria-label="Close details" title="Close (Esc)">
          <IconClose />
        </button>
      </header>

      <div className="oe-details-actions">
        <button
          type="button"
          className={`oe-btn${following ? ' is-on' : ''}`}
          aria-pressed={following}
          onClick={() => onFollowChange(!following)}
        >
          <IconTarget />
          {following ? 'Following' : 'Follow'}
        </button>
        {shareUrl && (
          <button type="button" className="oe-btn" onClick={() => void copyLink()}>
            {copied === 'done' ? <IconCheck /> : <IconLink />}
            {copied === 'done' ? 'Link copied' : copied === 'failed' ? 'Copy failed' : 'Copy link'}
          </button>
        )}
        {copied === 'failed' && shareUrl && (
          <input
            className="oe-copy-fallback oe-mono"
            readOnly
            value={shareUrl}
            aria-label="Link to this object; select and copy it"
            onFocus={(e) => e.currentTarget.select()}
            ref={(node) => node?.select()}
          />
        )}
        <span className="oe-visually-hidden" aria-live="polite">
          {copied === 'done' ? 'Link copied to clipboard' : copied === 'failed' ? 'Could not copy the link' : ''}
        </span>
      </div>

      <div className="oe-details-body">
        <Telemetry id={object.id} getLive={getLive} intervalMs={liveIntervalMs} />

        {error && (
          <div className="oe-alert" role="alert">
            <span>{error}</span>
            {onRetry && (
              <button type="button" className="oe-btn oe-btn-sm" onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        )}

        <section className="oe-section" aria-labelledby={`${titleId}-orbit`}>
          <h3 id={`${titleId}-orbit`}>Orbit</h3>
          <dl className="oe-rows">
            <Row label="Regime" value={REGIME_LABELS[object.regime]} title={REGIME_HINTS[object.regime]} />
            <Row mono label="Period" value={formatPeriod(object.periodMin)} />
            <Row mono label="Inclination" value={formatDeg(object.inclinationDeg, 2)} />
            <Row mono label="Apogee" value={formatKm(object.apogeeKm)} />
            <Row mono label="Perigee" value={formatKm(object.perigeeKm)} />
            <Row mono label="Eccentricity" value={formatEccentricity(object.eccentricity)} />
          </dl>
        </section>

        <section className="oe-section" aria-labelledby={`${titleId}-mission`}>
          <h3 id={`${titleId}-mission`}>Mission</h3>
          <dl className="oe-rows">
            <Row label="Owner" value={ownerName(object.owner)} title={object.owner ?? undefined} />
            <Row mono label="Launched" value={formatDate(object.launchDate)} />
            <Row label="Launch site" value={launchSiteLabel(object.launchSite)} title={object.launchSite ?? undefined} />
            <Row label="Time in orbit" value={formatTimeInOrbit(object.launchDate, simTimeMs)} />
            <Row label="Radar size" value={rcsLabel(object.rcs)} title="Radar cross-section class" />
          </dl>
          {description && <p className="oe-desc">{description}</p>}
          {loading && <p className="oe-note">Loading mission details…</p>}
        </section>

        <section className="oe-section" aria-labelledby={`${titleId}-data`}>
          <h3 id={`${titleId}-data`}>Data</h3>
          <dl className="oe-rows">
            <div className={`oe-row${stale ? ' is-warn' : ''}`}>
              <dt>Element set</dt>
              <dd className="oe-mono" title={object.epoch}>{formatAge(object.epoch, wallNow)}</dd>
            </div>
          </dl>
          {stale && (
            <p className="oe-warn">
              These orbital elements are over {STALE_EPOCH_DAYS} days old, so the shown position may be off by tens of
              kilometres or more.
            </p>
          )}
        </section>

        <section className="oe-section" aria-labelledby={`${titleId}-links`}>
          <h3 id={`${titleId}-links`}>Read more</h3>
          <ul className="oe-links">
            {links.map((l, i) => (
              <li key={`${i}-${l.href}`}>
                <a href={l.href} target="_blank" rel="noopener noreferrer">
                  {l.label}
                  <IconExternal />
                  <span className="oe-visually-hidden"> (opens in a new tab)</span>
                </a>
                {l.hint && <span className="oe-link-hint">{l.hint}</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  )
}

export const SatelliteDetails = memo(SatelliteDetailsImpl)
