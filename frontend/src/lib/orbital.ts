import * as THREE from 'three'
import { twoline2satrec, jday, gstime, propagate, eciToEcf, degreesToRadians, type SatRec } from './satellite-wrapper'

const EARTH_RADIUS = 2.2
const EARTH_RADIUS_KM = 6371
const ECEF_TO_THREE_SCALE = EARTH_RADIUS / EARTH_RADIUS_KM

export interface OrbitalElements {
  epoch: string
  meanMotion: number
  eccentricity: number
  inclination: number
  raan: number
  argOfPericenter: number
  meanAnomaly: number
  bstar: number
  meanMotionDot: number
  meanMotionDDot: number
}

export interface PropagatedState {
  positionEcef: THREE.Vector3
  velocityEcef: THREE.Vector3
  altitudeKm: number
  positionThree: THREE.Vector3
}

function ecefToThree(positionKm: number[]): THREE.Vector3 {
  return new THREE.Vector3(
    positionKm[0] * ECEF_TO_THREE_SCALE,
    positionKm[1] * ECEF_TO_THREE_SCALE,
    positionKm[2] * ECEF_TO_THREE_SCALE
  )
}

const deg2rad = degreesToRadians

export function buildSatrecFromElements(elements: OrbitalElements): SatRec {
  const epoch = new Date(elements.epoch)

  const satrec = twoline2satrec(
    `1 00000U 00000A   ${formatTleEpoch(epoch)}  .00000000  00000-0 ${formatBstar(elements.bstar)} 0  0000`,
    `2 00000 ${elements.inclination.toFixed(4)} ${elements.raan.toFixed(4)} ${elements.eccentricity.toFixed(7).padStart(7, '0')} ${elements.argOfPericenter.toFixed(4)} ${elements.meanAnomaly.toFixed(4)} ${elements.meanMotion.toFixed(8)}000000`
  )

  if (!satrec || satrec.error !== 0) {
    throw new Error(`Failed to create SatRec: error code ${satrec?.error ?? 'unknown'}`)
  }

  satrec.nokozai = elements.meanMotion * (2 * Math.PI) / 1440.0
  satrec.ecco = elements.eccentricity
  satrec.inclo = deg2rad(elements.inclination)
  satrec.nodeo = deg2rad(elements.raan)
  satrec.argpo = deg2rad(elements.argOfPericenter)
  satrec.mo = deg2rad(elements.meanAnomaly)
  satrec.bstar = elements.bstar
  satrec.ndot = elements.meanMotionDot * (2 * Math.PI) / 1440.0
  satrec.nddot = elements.meanMotionDDot * (2 * Math.PI) / 1440.0

  const jd = jday(
    epoch.getUTCFullYear(),
    epoch.getUTCMonth() + 1,
    epoch.getUTCDate(),
    epoch.getUTCHours(),
    epoch.getUTCMinutes(),
    epoch.getUTCSeconds() + epoch.getUTCMilliseconds() / 1000
  )
  satrec.jdsatepoch = jd - 2433281.5

  return satrec
}

function formatTleEpoch(date: Date): string {
  const year = date.getUTCFullYear() % 100
  const dayOfYear = Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000)
  const fraction = (date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds() + date.getUTCMilliseconds() / 1000) / 86400
  const dayFraction = dayOfYear + fraction
  return `${year.toString().padStart(2, '0')}${dayFraction.toFixed(8).padStart(12, '0')}`
}

function formatBstar(bstar: number): string {
  if (bstar === 0) return ' 00000-0'
  const exp = Math.floor(Math.log10(Math.abs(bstar)))
  const mantissa = Math.abs(bstar) / Math.pow(10, exp)
  const sign = bstar < 0 ? '-' : ' '
  return `${sign}${mantissa.toFixed(5).replace('.', '')}${exp < 0 ? exp.toString().padStart(2, '0') : '+' + exp.toString().padStart(1, '0')}`
}

export function propagateToEcef(satrec: SatRec, date: Date): PropagatedState | null {
  const positionVelocity = propagate(satrec, date)
  if (!positionVelocity || !positionVelocity.position) {
    return null
  }

  const pos = positionVelocity.position
  const vel = positionVelocity.velocity
  if (
    !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z) ||
    !Number.isFinite(vel.x) || !Number.isFinite(vel.y) || !Number.isFinite(vel.z)
  ) {
    return null
  }

  const gmst = gstime(date)
  const positionEci = positionVelocity.position
  const velocityEci = positionVelocity.velocity

  const positionEcef = eciToEcf(positionEci, gmst)
  const velocityEcef = eciToEcf(velocityEci, gmst)

  if (
    !Number.isFinite(positionEcef.x) || !Number.isFinite(positionEcef.y) || !Number.isFinite(positionEcef.z) ||
    !Number.isFinite(velocityEcef.x) || !Number.isFinite(velocityEcef.y) || !Number.isFinite(velocityEcef.z)
  ) {
    return null
  }

  const altitudeKm = Math.sqrt(
    positionEcef.x ** 2 + positionEcef.y ** 2 + positionEcef.z ** 2
  ) - EARTH_RADIUS_KM

  if (!Number.isFinite(altitudeKm)) {
    return null
  }

  return {
    positionEcef: new THREE.Vector3(positionEcef.x, positionEcef.y, positionEcef.z),
    velocityEcef: new THREE.Vector3(velocityEcef.x, velocityEcef.y, velocityEcef.z),
    altitudeKm,
    positionThree: ecefToThree([positionEcef.x, positionEcef.y, positionEcef.z]),
  }
}

export function generateOrbitPath(
  satrec: SatRec,
  referenceDate: Date,
  segments: number = 360
): THREE.Vector3[] {
  const periodMinutes = (2 * Math.PI) / (satrec.nokozai * 60)
  const positions: THREE.Vector3[] = []

  for (let i = 0; i <= segments; i++) {
    const fraction = i / segments
    const date = new Date(referenceDate.getTime() + fraction * periodMinutes * 60 * 1000)
    const state = propagateToEcef(satrec, date)
    if (state) {
      positions.push(state.positionThree.clone())
    }
  }

  return positions
}

export function getOrbitalPeriodMinutes(satrec: SatRec): number {
  return (2 * Math.PI) / (satrec.nokozai * 60)
}

export async function fetchOrbitalElements(objectId: number): Promise<OrbitalElements | null> {
  try {
    const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api/v1'}/objects/${objectId}/diagnostics`)
    if (!response.ok) return null
    const data = await response.json()
    const row = data.raw_latest_row
    if (!row) return null

    return {
      epoch: row.epoch,
      meanMotion: row.mean_motion,
      eccentricity: row.eccentricity,
      inclination: row.inclination,
      raan: row.ra_of_asc_node,
      argOfPericenter: row.arg_of_pericenter,
      meanAnomaly: row.mean_anomaly,
      bstar: row.bstar,
      meanMotionDot: row.mean_motion_dot,
      meanMotionDDot: row.mean_motion_ddot,
    }
  } catch {
    return null
  }
}

export function elementsFromDiagnostics(rawRow: Record<string, unknown>): OrbitalElements | null {
  if (!rawRow) return null
  return {
    epoch: rawRow.epoch as string,
    meanMotion: rawRow.mean_motion as number,
    eccentricity: rawRow.eccentricity as number,
    inclination: rawRow.inclination as number,
    raan: rawRow.ra_of_asc_node as number,
    argOfPericenter: rawRow.arg_of_pericenter as number,
    meanAnomaly: rawRow.mean_anomaly as number,
    bstar: rawRow.bstar as number,
    meanMotionDot: rawRow.mean_motion_dot as number,
    meanMotionDDot: rawRow.mean_motion_ddot as number,
  }
}