/* ============================================================
   LOOKUPS + FORMATTERS
   ------------------------------------------------------------
   Pure, dependency-free helpers for the interface: CelesTrak
   SATCAT owner and launch-site codes, object-type and regime
   labels, and number/date formatters. No emoji flags.
   ============================================================ */

import type { ObjectType, OrbitRegime } from '../engine/contract'

/* ---------- Owners (CelesTrak SATCAT "OWNER" / source codes) ---------- */

export const OWNER_NAMES: Readonly<Record<string, string>> = {
  AB: 'Arabsat',
  ABS: 'ABS (Asia Broadcast Satellite)',
  AC: 'AsiaSat',
  ALG: 'Algeria',
  ANG: 'Angola',
  ARGN: 'Argentina',
  ASRA: 'Austria',
  AUS: 'Australia',
  AZER: 'Azerbaijan',
  BEL: 'Belgium',
  BELA: 'Belarus',
  BERM: 'Bermuda',
  BGD: 'Bangladesh',
  BOL: 'Bolivia',
  BRAZ: 'Brazil',
  BUL: 'Bulgaria',
  CA: 'Canada',
  CHBZ: 'China and Brazil',
  CHLE: 'Chile',
  CHTU: 'China and Turkey',
  CIS: 'Russia / former USSR',
  COL: 'Colombia',
  CZCH: 'Czechia',
  DEN: 'Denmark',
  ECU: 'Ecuador',
  EGYP: 'Egypt',
  ESA: 'European Space Agency',
  ESRO: 'European Space Research Organisation',
  EST: 'Estonia',
  EUME: 'EUMETSAT',
  EUTE: 'Eutelsat',
  FGER: 'France and Germany',
  FIN: 'Finland',
  FR: 'France',
  FRIT: 'France and Italy',
  GER: 'Germany',
  GLOB: 'Globalstar',
  GREC: 'Greece',
  HUN: 'Hungary',
  IM: 'Inmarsat',
  IND: 'India',
  INDO: 'Indonesia',
  IRAN: 'Iran',
  IRAQ: 'Iraq',
  IRID: 'Iridium',
  ISRA: 'Israel',
  ISS: 'International Space Station partners',
  IT: 'Italy',
  ITSO: 'Intelsat',
  JPN: 'Japan',
  KAZ: 'Kazakhstan',
  KEN: 'Kenya',
  LAOS: 'Laos',
  LKA: 'Sri Lanka',
  LTU: 'Lithuania',
  LUXE: 'Luxembourg',
  MA: 'Morocco',
  MALA: 'Malaysia',
  MEX: 'Mexico',
  MNG: 'Mongolia',
  NATO: 'NATO',
  NETH: 'Netherlands',
  NICO: 'New ICO',
  NIG: 'Nigeria',
  NKOR: 'North Korea',
  NOR: 'Norway',
  NPL: 'Nepal',
  NZ: 'New Zealand',
  O3B: 'O3b Networks (SES)',
  ORB: 'Orbcomm',
  PAKI: 'Pakistan',
  PERU: 'Peru',
  POL: 'Poland',
  POR: 'Portugal',
  PRC: 'China',
  PRES: 'China and ESA',
  QAT: 'Qatar',
  RASC: 'RascomStar-QAF',
  ROC: 'Taiwan',
  ROM: 'Romania',
  RP: 'Philippines',
  SAFR: 'South Africa',
  SAUD: 'Saudi Arabia',
  SDN: 'Sudan',
  SEAL: 'Sea Launch',
  SES: 'SES',
  SGJP: 'Singapore and Japan',
  SING: 'Singapore',
  SKOR: 'South Korea',
  RWA: 'Rwanda',
  SVN: 'Slovenia',
  KWT: 'Kuwait',
  SVK: 'Slovakia',
  JOR: 'Jordan',
  HRV: 'Croatia',
  DJI: 'Djibouti',
  BWA: 'Botswana',
  BHR: 'Bahrain',
  MNE: 'Montenegro',
  SPN: 'Spain',
  STCT: 'Singapore and Taiwan',
  SWED: 'Sweden',
  SWTZ: 'Switzerland',
  THAI: 'Thailand',
  TMMC: 'Turkmenistan and Monaco',
  TURK: 'Türkiye',
  UAE: 'United Arab Emirates',
  UK: 'United Kingdom',
  UKR: 'Ukraine',
  URY: 'Uruguay',
  US: 'United States',
  USBZ: 'United States and Brazil',
  VENZ: 'Venezuela',
  VTNM: 'Vietnam',
  TBD: 'To be determined',
  UNK: 'Unknown',
}

/** Readable owner name, falling back to the raw code. */
export function ownerName(code: string | null | undefined): string {
  if (!code) return 'Unknown'
  return OWNER_NAMES[code.trim().toUpperCase()] ?? code
}

/* ---------- Launch sites (CelesTrak SATCAT "LAUNCH_SITE" codes) ---------- */

export interface LaunchSiteInfo {
  readonly name: string
  readonly country: string
}

export const LAUNCH_SITES: Readonly<Record<string, LaunchSiteInfo>> = {
  AFETR: { name: 'Cape Canaveral', country: 'United States' },
  AFWTR: { name: 'Vandenberg', country: 'United States' },
  CAS: { name: 'Canary Islands air launch', country: 'Spain (airspace)' },
  DLS: { name: 'Dombarovsky', country: 'Russia' },
  ECSLA: { name: 'East China Sea launch area', country: 'China' },
  ERAS: { name: 'Eastern Range air launch', country: 'United States' },
  FRGUI: { name: 'Guiana Space Centre, Kourou', country: 'French Guiana' },
  HGSTR: { name: 'Hammaguir', country: 'Algeria' },
  JSC: { name: 'Jiuquan', country: 'China' },
  KODAK: { name: 'Pacific Spaceport Complex, Kodiak', country: 'United States' },
  KSCUT: { name: 'Uchinoura', country: 'Japan' },
  KWAJ: { name: 'Kwajalein Atoll (Reagan Test Site)', country: 'Marshall Islands' },
  KYMSC: { name: 'Kapustin Yar', country: 'Russia' },
  JJSLA: { name: 'Jeju sea launch area', country: 'South Korea' },
  NSC: { name: 'Naro Space Center', country: 'South Korea' },
  PKMTR: { name: 'Pacific Missile Range Facility, Kauai', country: 'United States' },
  PLMSC: { name: 'Plesetsk', country: 'Russia' },
  RLLB: { name: 'Rocket Lab LC-1, Mahia', country: 'New Zealand' },
  SCSLA: { name: 'South China Sea launch area', country: 'China' },
  SADOL: { name: 'Submarine launch, Barents Sea', country: 'Russia' },
  SEAL: { name: 'Sea Launch platform', country: 'Pacific Ocean' },
  SEMLS: { name: 'Semnan', country: 'Iran' },
  SMTS: { name: 'Shahroud', country: 'Iran' },
  SNMLP: { name: 'San Marco platform', country: 'Kenya' },
  SRI: { name: 'Satish Dhawan, Sriharikota', country: 'India' },
  SRILR: { name: 'Satish Dhawan, Sriharikota', country: 'India' },
  SVOB: { name: 'Svobodny', country: 'Russia' },
  TANSC: { name: 'Tanegashima', country: 'Japan' },
  TSC: { name: 'Taiyuan', country: 'China' },
  // Codes below checked against on-orbit objects in CelesTrak SATCAT.
  TAISC: { name: 'Taiyuan', country: 'China' },
  XICLF: { name: 'Xichang', country: 'China' },
  STARB: { name: 'Starbase, Boca Chica', country: 'USA' },
  ANDSP: { name: 'Andøya Spaceport', country: 'Norway' },
  SVOBO: { name: 'Svobodny', country: 'Russia' },
  TYMSC: { name: 'Baikonur', country: 'Kazakhstan' },
  VOSTO: { name: 'Vostochny', country: 'Russia' },
  WLPIS: { name: 'Wallops Island', country: 'United States' },
  WOMRA: { name: 'Woomera', country: 'Australia' },
  WRAS: { name: 'Western Range air launch', country: 'United States' },
  WSC: { name: 'Wenchang', country: 'China' },
  XSC: { name: 'Xichang', country: 'China' },
  YAVNE: { name: 'Palmachim', country: 'Israel' },
  YSLA: { name: 'Yellow Sea launch area', country: 'China' },
  YUN: { name: 'Sohae', country: 'North Korea' },
}

export function launchSite(code: string | null | undefined): LaunchSiteInfo | null {
  if (!code) return null
  return LAUNCH_SITES[code.trim().toUpperCase()] ?? { name: code, country: '' }
}

/** "Baikonur, Kazakhstan"; raw code when unknown; "Unknown" when missing. */
export function launchSiteLabel(code: string | null | undefined): string {
  const site = launchSite(code)
  if (!site) return 'Unknown'
  return site.country ? `${site.name}, ${site.country}` : site.name
}

/* ---------- Object type + regime ---------- */

export const OBJECT_TYPES: readonly ObjectType[] = ['PAY', 'R/B', 'DEB', 'UNK']
export const ORBIT_REGIMES: readonly OrbitRegime[] = ['LEO', 'MEO', 'GEO', 'HEO']

export const OBJECT_TYPE_LABELS: Readonly<Record<ObjectType, string>> = {
  PAY: 'Payload',
  'R/B': 'Rocket body',
  DEB: 'Debris',
  UNK: 'Unknown',
}

export const OBJECT_TYPE_PLURAL: Readonly<Record<ObjectType, string>> = {
  PAY: 'payloads',
  'R/B': 'rocket bodies',
  DEB: 'debris',
  UNK: 'unknown',
}

export const REGIME_LABELS: Readonly<Record<OrbitRegime, string>> = {
  LEO: 'Low Earth orbit',
  MEO: 'Medium Earth orbit',
  GEO: 'Geosynchronous',
  HEO: 'Highly elliptical',
}

/** One-line explanation used in tooltips/titles for students. */
export const REGIME_HINTS: Readonly<Record<OrbitRegime, string>> = {
  LEO: 'Below about 2,000 km; one lap takes 90 to 130 minutes',
  MEO: 'Between LEO and GEO; home of GPS, Galileo and GLONASS',
  GEO: 'About 35,786 km up; one lap per sidereal day',
  HEO: 'Strongly elliptical, e.g. Molniya and transfer orbits',
}

/* ---------- RCS size class (SATCAT convention) ---------- */

export type RcsSize = 'Small' | 'Medium' | 'Large'

export function rcsSize(rcsM2: number | null | undefined): RcsSize | null {
  if (rcsM2 == null || !Number.isFinite(rcsM2)) return null
  if (rcsM2 < 0.1) return 'Small'
  if (rcsM2 <= 1) return 'Medium'
  return 'Large'
}

export function rcsLabel(rcsM2: number | null | undefined): string {
  const size = rcsSize(rcsM2)
  if (!size || rcsM2 == null) return 'Not published'
  return `${size} (${rcsM2 < 0.01 ? rcsM2.toExponential(1) : NUM_2.format(rcsM2)} m²)`
}

/* ---------- Formatters ---------- */

const NUM_0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const NUM_1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const NUM_2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const DAY_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const MS_DAY = 86_400_000

export function formatCount(n: number): string {
  return NUM_0.format(n)
}

export function formatKm(km: number | null | undefined): string {
  if (km == null || !Number.isFinite(km)) return '—'
  return `${Math.abs(km) < 100 ? NUM_1.format(km) : NUM_0.format(km)} km`
}

export function formatSpeed(kmS: number | null | undefined): string {
  if (kmS == null || !Number.isFinite(kmS)) return '—'
  return `${NUM_2.format(kmS)} km/s`
}

export function formatDeg(deg: number | null | undefined, digits = 1): string {
  if (deg == null || !Number.isFinite(deg)) return '—'
  return `${deg.toFixed(digits)}°`
}

export function formatLat(deg: number): string {
  if (!Number.isFinite(deg)) return '—'
  return `${Math.abs(deg).toFixed(2)}° ${deg >= 0 ? 'N' : 'S'}`
}

export function formatLon(deg: number): string {
  if (!Number.isFinite(deg)) return '—'
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180
  return `${Math.abs(wrapped).toFixed(2)}° ${wrapped >= 0 ? 'E' : 'W'}`
}

/** Orbital period: "92.9 min" under 3 h, otherwise "23 h 56 min". */
export function formatPeriod(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—'
  if (minutes < 180) return `${NUM_1.format(minutes)} min`
  const total = Math.round(minutes)
  return `${Math.floor(total / 60)} h ${total % 60} min`
}

export function formatEccentricity(e: number | null | undefined): string {
  if (e == null || !Number.isFinite(e)) return '—'
  return e.toFixed(e < 0.001 ? 5 : 4)
}

const HAS_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/

/** Epoch ms; zone-less ISO date-times (OMM EPOCH) are read as UTC, not local time. */
function toMs(value: string | number | null | undefined): number | null {
  if (value == null) return null
  let text = typeof value === 'string' ? value.trim() : ''
  if (text.includes('T') && !HAS_ZONE.test(text)) text += 'Z'
  const ms = typeof value === 'number' ? value : Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/** "20 Nov 1998" (UTC). */
export function formatDate(value: string | number | null | undefined): string {
  const ms = toMs(value)
  return ms === null ? 'Unknown' : DATE_FMT.format(ms)
}

export function formatYear(value: string | null | undefined): string {
  const ms = toMs(value)
  return ms === null ? '—' : String(new Date(ms).getUTCFullYear())
}

/** Sim clock face: { day: "Fri, 23 Oct 2026", time: "14:05:09" } in UTC. */
export function formatUtcParts(ms: number): { day: string; time: string } {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return { day: '—', time: '--:--:--' }
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    day: DAY_FMT.format(d),
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  }
}

/** Signed duration in words: "3 h 12 min", "4.2 days", "45 s". */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  if (!Number.isFinite(abs)) return '—'
  if (abs < 59_500) return `${Math.round(abs / 1000)} s`
  // Round to whole minutes first so "60 min" / "3 h 60 min" can never appear.
  const minutes = Math.round(abs / 60_000)
  if (minutes < 60) return `${minutes} min`
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m ? `${h} h ${m} min` : `${h} h`
  }
  const days = abs / MS_DAY
  if (days < 60) return `${NUM_1.format(days)} days`
  if (days < 730) return `${Math.round(days / 30.44)} months`
  return `${NUM_1.format(days / 365.25)} years`
}

/** Age of a timestamp relative to `nowMs`, e.g. "6 h ago". */
export function formatAge(value: string | number | null | undefined, nowMs: number): string {
  const ms = toMs(value)
  if (ms === null) return 'Unknown'
  const delta = nowMs - ms
  if (Math.abs(delta) < 30_000) return 'just now'
  return delta >= 0 ? `${formatDuration(delta)} ago` : `in ${formatDuration(delta)}`
}

export function ageDays(value: string | number | null | undefined, nowMs: number): number | null {
  const ms = toMs(value)
  return ms === null ? null : (nowMs - ms) / MS_DAY
}

/** Time in orbit since launch: "27 years, 11 months" / "8 months" / "12 days". */
export function formatTimeInOrbit(launch: string | null | undefined, nowMs: number): string {
  const ms = toMs(launch)
  if (ms === null) return 'Unknown'
  const days = Math.max(0, (nowMs - ms) / MS_DAY)
  if (days < 60) return `${Math.floor(days)} days`
  const months = Math.floor(days / 30.4375)
  const years = Math.floor(months / 12)
  const rest = months - years * 12
  if (!years) return `${months} months`
  const y = `${years} year${years === 1 ? '' : 's'}`
  return rest ? `${y}, ${rest} month${rest === 1 ? '' : 's'}` : y
}

/** Element sets older than this are flagged as possibly inaccurate. */
export const STALE_EPOCH_DAYS = 7

/* ---------- Time warp presets ---------- */

export interface WarpPreset {
  readonly warp: number
  readonly label: string
  readonly title: string
}

export const DEFAULT_WARP_PRESETS: readonly WarpPreset[] = [
  { warp: 1, label: '1×', title: 'Real time' },
  { warp: 10, label: '10×', title: '10 seconds per second' },
  { warp: 60, label: '60×', title: '1 minute per second' },
  { warp: 300, label: '5 min/s', title: '5 minutes per second' },
  { warp: 1800, label: '30 min/s', title: '30 minutes per second' },
]
