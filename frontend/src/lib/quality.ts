/* ============================================================
   DEVICE QUALITY PROFILE
   ------------------------------------------------------------
   Picks texture resolution, mesh density and render settings once
   at startup so weak devices (old phones, integrated GPUs, 2 GB RAM)
   get a scene they can actually draw. Override with ?quality=low|mid|high; the 8K high tier is opt-in only.
   Texture tiers are produced by `npm run textures`.
   ============================================================ */

export type QualityTier = 'low' | 'mid' | 'high'

export type TextureSet = {
  day: string
  night: string
  clouds: string
  normal: string
  stars: string
}

export type QualityProfile = {
  tier: QualityTier
  webgl: boolean
  sphereSegments: number
  dpr: [number, number]
  antialias: boolean
  anisotropy: number
  normalMap: boolean
  clouds: boolean
  satelliteHalo: boolean
  /** Lower tiers to show first while the target tier streams in. */
  textureChain: TextureSet[]
}

const TEXTURES: Record<QualityTier, TextureSet> = {
  low: {
    day: '/textures/low/earth_day.jpg',
    night: '/textures/low/earth_night.jpg',
    clouds: '/textures/low/earth_clouds.jpg',
    normal: '/textures/low/earth_normal.jpg',
    stars: '/textures/low/stars.jpg',
  },
  mid: {
    day: '/textures/mid/earth_day.jpg',
    night: '/textures/mid/earth_night.jpg',
    clouds: '/textures/mid/earth_clouds.jpg',
    normal: '/textures/mid/earth_normal.jpg',
    stars: '/textures/mid/stars.jpg',
  },
  high: {
    day: '/textures/8k_earth_daymap.jpg',
    night: '/textures/8k_earth_nightmap.jpg',
    clouds: '/textures/8k_earth_clouds.jpg',
    normal: '/textures/8k_earth_normal_map.png',
    stars: '/textures/8k_stars_milky_way.jpg',
  },
}

const PROFILES: Record<QualityTier, Omit<QualityProfile, 'webgl'>> = {
  low: {
    tier: 'low',
    sphereSegments: 48,
    dpr: [1, 1],
    antialias: false,
    anisotropy: 1,
    normalMap: false,
    clouds: false,
    satelliteHalo: false,
    textureChain: [TEXTURES.low],
  },
  mid: {
    tier: 'mid',
    sphereSegments: 96,
    dpr: [1, 1.5],
    antialias: true,
    anisotropy: 4,
    normalMap: true,
    clouds: true,
    satelliteHalo: true,
    textureChain: [TEXTURES.low, TEXTURES.mid],
  },
  high: {
    tier: 'high',
    sphereSegments: 128,
    dpr: [1, 1.75],
    antialias: true,
    anisotropy: 8,
    normalMap: true,
    clouds: true,
    satelliteHalo: true,
    textureChain: [TEXTURES.low, TEXTURES.high],
  },
}

type NavigatorHints = Navigator & {
  deviceMemory?: number
  connection?: { saveData?: boolean; effectiveType?: string }
}

/** Returns MAX_TEXTURE_SIZE, or 0 when WebGL is unavailable. */
function probeMaxTextureSize(): number {
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return 0
    const size = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return size
  } catch {
    return 0
  }
}

function readOverride(): QualityTier | null {
  const value = new URLSearchParams(window.location.search).get('quality')
  return value === 'low' || value === 'mid' || value === 'high' ? value : null
}

export function detectQuality(): QualityProfile {
  const maxTextureSize = probeMaxTextureSize()
  const webgl = maxTextureSize > 0
  const override = readOverride()
  if (override) return { ...PROFILES[override], webgl }

  const nav = navigator as NavigatorHints
  const memoryGb = nav.deviceMemory ?? 4
  const cores = nav.hardwareConcurrency ?? 4
  const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const saveData = nav.connection?.saveData === true || /(^|-)2g$/.test(nav.connection?.effectiveType ?? '')

  // 8K textures cost ~700 MB of GPU memory and long upload stalls even on capable
  // integrated GPUs, so the high tier is opt-in (?quality=high), never auto-picked.
  let tier: QualityTier = 'mid'
  if (saveData || memoryGb <= 2 || cores <= 2 || maxTextureSize < 4096) tier = 'low'
  else if (coarsePointer && memoryGb <= 3) tier = 'low'

  return { ...PROFILES[tier], webgl }
}
