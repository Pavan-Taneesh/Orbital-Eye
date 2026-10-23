import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { OrbitControls, PerformanceMonitor } from '@react-three/drei'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { RefObject } from 'react'
import * as THREE from 'three'
import { api, safeExternalUrl, type AICommandResult, type ObjectDetails } from './lib/types'
import { detectQuality, type QualityProfile, type TextureSet } from './lib/quality'
import {
  EARTH_RADIUS_SCENE,
  Propagator,
  createSimClock,
  earthRotationY,
  getObjectDetails,
  loadCatalog,
  sunDirectionScene,
  type CatalogObject,
  type Filters,
  type LiveState,
  type LoadedCatalog,
  type TimeState,
} from './engine'
import {
  FilterPanel,
  HoverTooltip,
  OBJECT_TYPES,
  ORBIT_REGIMES,
  Rail,
  SatelliteDetails,
  SearchBox,
  StatsBar,
  TimeControls,
  buildSearchIndex,
  computeBreakdown,
  computeFacetCounts,
  passesFilters,
  type CategoryInfo,
} from './ui'
import type { HoverTooltipHandle } from './ui/HoverTooltip'

const EARTH_RADIUS = EARTH_RADIUS_SCENE

// A pointer that travels further than this between down and up is a drag, not a click.
const CLICK_TOLERANCE_PX = 6

const CAMERA_FOV = 40
const CAMERA_MAX_DISTANCE = 17
/** Directional light distance along the Sun direction (only the direction matters). */
const SUN_LIGHT_DISTANCE = 10

/** Distance that keeps the whole globe in frame, including on tall phone screens. */
function homeDistance(aspect: number): number {
  const halfFov = THREE.MathUtils.degToRad(CAMERA_FOV / 2)
  const fitWidth = (EARTH_RADIUS * 1.35) / (Math.tan(halfFov) * Math.max(aspect, 0.1))
  return THREE.MathUtils.clamp(fitWidth, 10.5, CAMERA_MAX_DISTANCE - 0.5)
}

/* ============================================================
   SIMULATION CLOCK
   ------------------------------------------------------------
   One app-lifetime clock drives the propagator, the Earth's spin,
   the Sun and the time controls. Module-level so React StrictMode's
   double effects never dispose it.
   ============================================================ */

const clock = createSimClock()

/* ============================================================
   CATEGORIES
   ============================================================ */

// Mirrors the seven backend categories (backend/db/seed.sql) one-to-one.
const CATEGORIES: readonly CategoryInfo[] = [
  { id: 1, name: 'Space stations', color: '#6fff9f' },
  { id: 2, name: 'Navigation', color: '#ffcf4f' },
  { id: 3, name: 'Communication', color: '#4fd3ff' },
  { id: 4, name: 'Weather', color: '#ff6f91' },
  { id: 5, name: 'Scientific', color: '#b58bff' },
  { id: 6, name: 'Rocket bodies', color: '#ff9b54' },
  { id: 7, name: 'Debris', color: '#8d99ae' },
]
const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]))

function categoryColor(categoryId: number): string {
  return CATEGORY_BY_ID.get(categoryId)?.color ?? '#ffffff'
}

const ALL_FILTERS: Filters = {
  categories: new Set(CATEGORIES.map((c) => c.id)),
  regimes: new Set(ORBIT_REGIMES),
  types: new Set(OBJECT_TYPES),
}

function activeFilterCount(f: Filters): number {
  return (
    (f.categories.size < CATEGORIES.length ? 1 : 0) +
    (f.regimes.size < ORBIT_REGIMES.length ? 1 : 0) +
    (f.types.size < OBJECT_TYPES.length ? 1 : 0)
  )
}

/* ============================================================
   DEEP LINKS  (?sat=<NORAD>, ?norad=<NORAD> accepted too)
   ============================================================ */

function readDeepLinkNorad(): number | null {
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('sat') ?? params.get('norad')
  if (!raw) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function writeDeepLink(norad: number | null): void {
  const url = new URL(window.location.href)
  url.searchParams.delete('norad')
  if (norad === null) url.searchParams.delete('sat')
  else url.searchParams.set('sat', String(norad))
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url)
}

function shareUrlFor(norad: number): string {
  return `${window.location.origin}${window.location.pathname}?sat=${norad}`
}

/* ============================================================
   HOVER STORE
   ------------------------------------------------------------
   The scene writes the hovered index here; only the tooltip
   subscribes, so hovering never re-renders App.
   ============================================================ */

type HoverStore = {
  get: () => number
  set: (index: number) => void
  subscribe: (fn: () => void) => () => void
}

function createHoverStore(): HoverStore {
  let current = -1
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set: (index) => {
      if (index === current) return
      current = index
      for (const fn of listeners) fn()
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/** The propagator together with the catalog version it was built from (indices match). */
type Engine = { catalog: LoadedCatalog; propagator: Propagator }

/** Shared between the satellite layer (writer) and the camera rig (reader), per frame. */
type SelectedPosition = { v: THREE.Vector3; valid: boolean }

/* ============================================================
   ENVIRONMENT HOOKS
   ============================================================ */

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  )
}

function useClockState(): TimeState {
  const [state, setState] = useState<TimeState>(() => clock.state)
  useEffect(() => clock.subscribe(setState), [])
  return state
}

function loadTexture(loader: THREE.TextureLoader, path: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(path, resolve, undefined, reject)
  })
}

/* ============================================================
   NIGHT-SIDE CITY LIGHTS
   ============================================================ */

function NightLights({
  texture,
  geometry,
  revealRef,
}: {
  texture: THREE.Texture
  geometry: THREE.BufferGeometry
  revealRef: { current: number }
}) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          nightMap: { value: null },
          sunDirection: { value: new THREE.Vector3(1, 0, 0) },
          reveal: { value: 0 },
        },

        vertexShader: `
          varying vec2 vUv;
          varying vec3 vWorldNormal;

          void main() {
            vUv = uv;
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldNormal = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
          }
        `,

        fragmentShader: `
          uniform sampler2D nightMap;
          uniform vec3 sunDirection;
          uniform float reveal;

          varying vec2 vUv;
          varying vec3 vWorldNormal;

          void main() {
            float sunlight = dot(normalize(vWorldNormal), sunDirection);
            float nightFactor = smoothstep(0.16, -0.28, sunlight);
            if (nightFactor <= 0.0) discard;
            vec3 lights = texture2D(nightMap, vUv).rgb;
            float brightness = max(max(lights.r, lights.g), lights.b);
            float mask = smoothstep(0.025, 0.16, brightness);
            float alpha = nightFactor * mask * 0.92 * reveal;
            gl_FragColor = vec4(lights, alpha);
          }
        `,

        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )

  const materialRef = useRef<THREE.ShaderMaterial>(null)
  useEffect(() => () => material.dispose(), [material])

  useFrame(() => {
    const current = materialRef.current
    if (!current) return
    current.uniforms.nightMap.value = texture
    current.uniforms.reveal.value = revealRef.current
    const [x, y, z] = sunDirectionScene(clock.now())
    ;(current.uniforms.sunDirection.value as THREE.Vector3).set(x, y, z)
  })

  return (
    <mesh geometry={geometry} scale={1.0015}>
      <primitive object={material} attach="material" ref={materialRef} />
    </mesh>
  )
}

/* ============================================================
   ATMOSPHERE
   ============================================================ */

function Atmosphere({ geometry, revealRef }: { geometry: THREE.BufferGeometry; revealRef: { current: number } }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          atmosphereColor: { value: new THREE.Color('#4bbcff') },
          reveal: { value: 0 },
        },

        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vWorldPosition;

          void main() {
            vNormal = normalize(mat3(modelMatrix) * normal);
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
          }
        `,

        fragmentShader: `
          uniform vec3 atmosphereColor;
          uniform float reveal;

          varying vec3 vNormal;
          varying vec3 vWorldPosition;

          void main() {
            vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
            float fresnel = pow(1.0 - max(0.0, dot(normalize(vNormal), viewDirection)), 5.0);
            float intensity = fresnel * 0.09 * reveal;
            gl_FragColor = vec4(atmosphereColor, intensity);
          }
        `,

        transparent: true,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.NormalBlending,
      }),
    [],
  )

  const materialRef = useRef<THREE.ShaderMaterial>(null)
  useEffect(() => () => material.dispose(), [material])

  useFrame(() => {
    if (materialRef.current) materialRef.current.uniforms.reveal.value = revealRef.current
  })

  return (
    <mesh geometry={geometry} scale={1.013}>
      <primitive object={material} attach="material" ref={materialRef} />
    </mesh>
  )
}

/* ============================================================
   EARTH
   ------------------------------------------------------------
   Textures stream progressively: the small tier appears first, the
   device's target tier replaces it when ready. Every texture set that
   is replaced or unmounted is disposed to free GPU memory.
   The globe's spin is the real one: rotation.y = GMST(sim time), so
   Earth-fixed longitude 0 points at Greenwich in the inertial scene.
   ============================================================ */

type EarthTextures = {
  day: THREE.Texture
  night: THREE.Texture
  cloud: THREE.Texture | null
  normal: THREE.Texture | null
}

function disposeEarthTextures(textures: EarthTextures | null) {
  if (!textures) return
  textures.day.dispose()
  textures.night.dispose()
  textures.cloud?.dispose()
  textures.normal?.dispose()
}

function Earth({
  active,
  quality,
  onReady,
}: {
  active: boolean
  quality: QualityProfile
  onReady?: () => void
}) {
  const earthGroup = useRef<THREE.Group>(null)
  const dayMaterialRef = useRef<THREE.MeshStandardMaterial & THREE.MeshLambertMaterial>(null)
  const cloudMaterialRef = useRef<THREE.MeshStandardMaterial>(null)

  const revealRef = useRef(0)
  const revealStart = useRef<number | null>(null)
  // Props only set the initial reveal state; useFrame owns opacity afterwards.
  const opaqueRef = useRef(false)

  const [textures, setTextures] = useState<EarthTextures | null>(null)
  const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy())
  const notifyReady = useEffectEvent(() => onReady?.())

  // One sphere shared by every Earth layer; layers differ only by scale.
  const sphere = useMemo(
    () => new THREE.SphereGeometry(EARTH_RADIUS, quality.sphereSegments, Math.round(quality.sphereSegments * 0.75)),
    [quality.sphereSegments],
  )
  useEffect(() => () => sphere.dispose(), [sphere])

  const normalScale = useMemo(() => new THREE.Vector2(0.65, 0.65), [])

  useEffect(() => {
    const loader = new THREE.TextureLoader()
    const anisotropy = Math.min(quality.anisotropy, maxAnisotropy)
    let cancelled = false
    let current: EarthTextures | null = null

    const prepare = (texture: THREE.Texture, colorSpace: THREE.ColorSpace) => {
      texture.colorSpace = colorSpace
      texture.anisotropy = anisotropy
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.ClampToEdgeWrapping
      texture.minFilter = THREE.LinearMipmapLinearFilter
      texture.magFilter = THREE.LinearFilter
      return texture
    }

    const loadSet = async (set: TextureSet): Promise<EarthTextures> => {
      const [day, night, cloud, normal] = await Promise.all([
        loadTexture(loader, set.day),
        loadTexture(loader, set.night),
        quality.clouds ? loadTexture(loader, set.clouds) : Promise.resolve(null),
        quality.normalMap ? loadTexture(loader, set.normal) : Promise.resolve(null),
      ])
      return {
        day: prepare(day, THREE.SRGBColorSpace),
        night: prepare(night, THREE.SRGBColorSpace),
        cloud: cloud && prepare(cloud, THREE.SRGBColorSpace),
        normal: normal && prepare(normal, THREE.NoColorSpace),
      }
    }

    void (async () => {
      for (const [index, set] of quality.textureChain.entries()) {
        try {
          const next = await loadSet(set)
          if (cancelled) {
            disposeEarthTextures(next)
            return
          }
          const previous = current
          current = next
          setTextures(next)
          // Let the new set reach the GPU before freeing the old one.
          window.setTimeout(() => disposeEarthTextures(previous), 500)
          if (index === 0) notifyReady()
        } catch (error) {
          console.error('Failed to load Earth textures:', error)
          if (index === 0) notifyReady() // never block the intro on a texture failure
        }
      }
    })()

    return () => {
      cancelled = true
      disposeEarthTextures(current)
    }
  }, [quality, maxAnisotropy])

  useFrame((state) => {
    const group = earthGroup.current
    if (!group) return

    group.rotation.y = earthRotationY(clock.now())

    if (!active) {
      group.scale.setScalar(0.001)
      return
    }

    if (revealStart.current === null) {
      revealStart.current = state.clock.elapsedTime
    }

    const REVEAL_DURATION = 1.7
    const elapsed = state.clock.elapsedTime - revealStart.current
    const raw = Math.min(1, elapsed / REVEAL_DURATION)
    const eased = 1 - Math.pow(1 - raw, 3)

    // Materialize the Earth instead of scaling it up from almost nothing.
    group.scale.setScalar(0.96 + eased * 0.04)
    revealRef.current = eased

    const day = dayMaterialRef.current
    if (day && !opaqueRef.current) {
      day.opacity = eased
      if (raw >= 1) {
        // Once revealed, render the globe in the cheaper opaque pass.
        day.transparent = false
        day.needsUpdate = true
        opaqueRef.current = true
      }
    }
    if (cloudMaterialRef.current) cloudMaterialRef.current.opacity = 0.44 * eased
  })

  if (!textures) return null

  return (
    <group ref={earthGroup}>
      <mesh geometry={sphere}>
        {quality.normalMap && textures.normal ? (
          <meshStandardMaterial
            ref={dayMaterialRef}
            map={textures.day}
            normalMap={textures.normal}
            normalScale={normalScale}
            roughness={0.82}
            metalness={0}
            transparent
            opacity={0}
          />
        ) : (
          <meshLambertMaterial
            ref={dayMaterialRef}
            map={textures.day}
            transparent
            opacity={0}
          />
        )}
      </mesh>

      <NightLights texture={textures.night} geometry={sphere} revealRef={revealRef} />

      {textures.cloud && (
        <mesh geometry={sphere} scale={1.007}>
          <meshStandardMaterial
            ref={cloudMaterialRef}
            map={textures.cloud}
            transparent
            opacity={0}
            depthWrite={false}
            roughness={1}
            metalness={0}
          />
        </mesh>
      )}

      <Atmosphere geometry={sphere} revealRef={revealRef} />
    </group>
  )
}

/** Directional "Sun" light that tracks the real Sun direction for the sim time. */
function SunLight() {
  const lightRef = useRef<THREE.DirectionalLight>(null)
  useFrame(() => {
    const light = lightRef.current
    if (!light) return
    const [x, y, z] = sunDirectionScene(clock.now())
    light.position.set(x * SUN_LIGHT_DISTANCE, y * SUN_LIGHT_DISTANCE, z * SUN_LIGHT_DISTANCE)
  })
  return <directionalLight ref={lightRef} intensity={2.9} color="#ffffff" />
}

/* ============================================================
   STARFIELD SKYBOX
   ============================================================ */

function Starfield({ quality, onReady }: { quality: QualityProfile; onReady?: () => void }) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null)
  const materialRef = useRef<THREE.MeshBasicMaterial>(null)
  const revealStart = useRef<number | null>(null)
  const notifyReady = useEffectEvent(() => onReady?.())

  // The skybox is soft; the target tier's last texture set is plenty.
  const starsUrl = quality.textureChain[quality.textureChain.length - 1].stars
  const segments = quality.tier === 'low' ? 24 : 48

  useEffect(() => {
    const loader = new THREE.TextureLoader()
    let cancelled = false
    let loaded: THREE.Texture | null = null

    loadTexture(loader, starsUrl)
      .then((tex) => {
        if (cancelled) {
          tex.dispose()
          return
        }
        tex.colorSpace = THREE.SRGBColorSpace
        loaded = tex
        setTexture(tex)
        notifyReady()
      })
      .catch((error) => {
        console.error('Failed to load starfield texture:', error)
        notifyReady()
      })

    return () => {
      cancelled = true
      loaded?.dispose()
    }
  }, [starsUrl])

  useFrame((state) => {
    if (!texture || !materialRef.current) return
    if (revealStart.current === null) revealStart.current = state.clock.elapsedTime
    const raw = Math.min(1, (state.clock.elapsedTime - revealStart.current) / 1.8)
    materialRef.current.opacity = 0.82 * (1 - Math.pow(1 - raw, 3))
  })

  if (!texture) return null

  return (
    <mesh rotation={[0, Math.PI / 2, 0]} renderOrder={0} raycast={() => null}>
      <sphereGeometry args={[90, segments, Math.round(segments / 2)]} />
      <meshBasicMaterial
        ref={materialRef}
        map={texture}
        side={THREE.BackSide}
        toneMapped={false}
        depthWrite={false}
        opacity={0}
        transparent
      />
    </mesh>
  )
}

/* ============================================================
   SELECTED OBJECT'S ORBIT RING
   ------------------------------------------------------------
   One revolution from the worker (real SGP4), starting at the
   object's current position. Refreshed every period/8 of sim time
   (drag and J2 precession) and immediately after a seek.
   ============================================================ */

const ORBIT_SAMPLES = 180

function OrbitRing({
  propagator,
  index,
  periodMin,
  color,
}: {
  propagator: Propagator
  index: number
  periodMin: number
  color: string
}) {
  const line = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const attr = new THREE.BufferAttribute(new Float32Array(ORBIT_SAMPLES * 3), 3)
    attr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', attr)
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000)
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.76,
      depthWrite: false,
      toneMapped: false,
    })
    // `<line>` collides with the SVG element type in JSX, so build the object directly.
    const object = new THREE.LineLoop(geometry, material)
    object.raycast = () => {}
    object.frustumCulled = false
    object.visible = false
    return object
  }, [color])

  useEffect(
    () => () => {
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    },
    [line],
  )

  const lastFetchSim = useRef(Number.NaN)
  const inflight = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useFrame(() => {
    if (inflight.current) return
    const t = clock.now()
    const refreshMs = Number.isFinite(periodMin) ? (periodMin * 60_000) / 8 : 600_000
    if (Number.isFinite(lastFetchSim.current) && Math.abs(t - lastFetchSim.current) < refreshMs) return
    inflight.current = true
    lastFetchSim.current = t
    propagator
      .getOrbitPath(index, t, ORBIT_SAMPLES)
      .then((points) => {
        if (!alive.current) return
        const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute
        const out = attr.array as Float32Array
        // A loop can't skip NaN vertices: repeat the last valid point over gaps.
        let lastValid = -1
        for (let k = 0; k < ORBIT_SAMPLES; k++) {
          if (Number.isFinite(points[k * 3])) {
            lastValid = k
            break
          }
        }
        if (lastValid < 0) {
          line.visible = false
          return
        }
        for (let k = 0; k < ORBIT_SAMPLES; k++) {
          const src = Number.isFinite(points[k * 3]) ? k : lastValid
          lastValid = src
          out[k * 3] = points[src * 3]
          out[k * 3 + 1] = points[src * 3 + 1]
          out[k * 3 + 2] = points[src * 3 + 2]
        }
        attr.needsUpdate = true
        line.visible = true
      })
      .catch(() => {
        if (alive.current) line.visible = false
      })
      .finally(() => {
        inflight.current = false
      })
  })

  return <primitive object={line} />
}

/* ============================================================
   SATELLITE FIELD
   ------------------------------------------------------------
   The whole catalog is one GPU Points object. Every frame the
   propagator writes interpolated SGP4 positions straight into the
   position attribute (no allocation). Colours are additive, so a
   filtered-out object is simply black (invisible) and is skipped
   by picking.
   ============================================================ */

function createSatelliteParticleTexture(): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Unable to create satellite particle texture')

  const center = size / 2
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.16, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.38, 'rgba(255,255,255,0.92)')
  gradient.addColorStop(0.63, 'rgba(255,255,255,0.46)')
  gradient.addColorStop(0.82, 'rgba(255,255,255,0.10)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')

  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return texture
}

/* Tuned for a full catalog (thousands of points, additive): smaller and dimmer than
   a hand-picked set, so the dense LEO shell doesn't saturate to white. */
const POINT_SIZE = 0.11
const BASE_BRIGHTNESS = 1.25
const HALO_SIZE = 0.3
const HALO_OPACITY = 0.3

type FieldBuffers = {
  core: THREE.BufferGeometry
  halo: THREE.BufferGeometry
}

function makeFieldBuffers(count: number): FieldBuffers {
  const position = new THREE.BufferAttribute(new Float32Array(count * 3), 3)
  position.setUsage(THREE.DynamicDrawUsage)
  const color = new THREE.BufferAttribute(new Float32Array(count * 3), 3)
  // Positions change every frame and HEO apogees reach far out: never recompute bounds.
  const bounds = new THREE.Sphere(new THREE.Vector3(), 1000)
  const core = new THREE.BufferGeometry()
  core.setAttribute('position', position)
  core.setAttribute('color', color)
  core.boundingSphere = bounds
  // The halo shares the same attributes (uploaded once), just drawn bigger and softer.
  const halo = new THREE.BufferGeometry()
  halo.setAttribute('position', position)
  halo.setAttribute('color', color)
  halo.boundingSphere = bounds
  return { core, halo }
}

function SatellitesLayer({
  engine,
  filters,
  selectedIndex,
  halo,
  hoverStore,
  tooltipRef,
  selectedPosRef,
  onSelect,
  onBackgroundClick,
}: {
  engine: Engine
  filters: Filters
  selectedIndex: number
  halo: boolean
  hoverStore: HoverStore
  tooltipRef: RefObject<HoverTooltipHandle | null>
  selectedPosRef: RefObject<SelectedPosition>
  onSelect: (id: number) => void
  onBackgroundClick: () => void
}) {
  const { catalog, propagator } = engine
  const objects = catalog.objects
  const [hoveredIndex, setHoveredIndex] = useState(-1)
  const markerRef = useRef<THREE.Group>(null)
  const particleTexture = useMemo(() => createSatelliteParticleTexture(), [])
  useEffect(() => () => particleTexture.dispose(), [particleTexture])

  const buffers = useMemo(() => makeFieldBuffers(objects.length), [objects])
  useEffect(
    () => () => {
      buffers.core.dispose()
      buffers.halo.dispose()
    },
    [buffers],
  )
  const occluderGeometry = useMemo(() => new THREE.SphereGeometry(EARTH_RADIUS, 32, 16), [])
  useEffect(() => () => occluderGeometry.dispose(), [occluderGeometry])
  const markerPosition = useMemo(() => new Float32Array(3), [])
  /** 1 = passes the filters (visible and pickable), index-aligned with `objects`. */
  const visibleRef = useRef<Uint8Array>(new Uint8Array(0))

  useFrame(() => {
    const t = clock.now()
    propagator.setTime(t)
    const position = buffers.core.getAttribute('position') as THREE.BufferAttribute
    const array = position.array as Float32Array
    if (propagator.writePositions(array, t)) position.needsUpdate = true

    const marker = markerRef.current
    if (selectedIndex >= 0) {
      const o = selectedIndex * 3
      const x = array[o]
      const y = array[o + 1]
      const z = array[o + 2]
      // Invalid objects are written at the origin (hidden inside the Earth).
      const valid = propagator.hasPositions && x * x + y * y + z * z > 1
      selectedPosRef.current.v.set(x, y, z)
      selectedPosRef.current.valid = valid
      if (marker) {
        marker.visible = valid
        marker.position.set(x, y, z)
      }
    } else {
      selectedPosRef.current.valid = false
    }
  })

  // Real-time propagation for selected satellite
  useFrame((_, delta) => {
    if (!selectedId) {
      setSelectedSatPosition(null)
      return
    }

    const sat = satellites.find((s) => s.id === selectedId)
    if (!sat) {
      setSelectedSatPosition(null)
      return
    }

    const objectId = sat.objectId
    const orbitData = orbitDataCache.get(objectId)
    if (!orbitData) {
      // Fall back to static state position if orbit data not loaded yet
      const pos = getSatelliteWorldPosition(sat, selectedSatelliteState, satelliteCache, selectedId)
      setSelectedSatPosition(pos)
      return
    }

    // Advance simulation time
    simTimeRef.current = new Date(simTimeRef.current.getTime() + delta * 1000)

    const state = propagateToEcef(orbitData.satrec, simTimeRef.current)
    if (state) {
      setSelectedSatPosition(state.positionThree)
    }
  })

  useEffect(() => {
    const colorAttr = buffers.core.getAttribute('color') as THREE.BufferAttribute
    const colors = colorAttr.array as Float32Array
    const visible = new Uint8Array(objects.length)
    const white = new THREE.Color('#ffffff')
    const base = new THREE.Color()
    const palette = new Map(CATEGORIES.map((c) => [c.id, new THREE.Color(c.color)]))
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i]
      const pass = passesFilters(o, filters)
      visible[i] = pass ? 1 : 0
      const o3 = i * 3
      if (!pass) {
        colors[o3] = colors[o3 + 1] = colors[o3 + 2] = 0
        continue
      }
      const selected = i === selectedIndex
      const hovered = i === hoveredIndex
      base.copy(selected || hovered ? white : (palette.get(o.categoryId) ?? white))
      const multiplier = selected ? 3.0 : hovered ? 2.1 : BASE_BRIGHTNESS
      colors[o3] = base.r * multiplier
      colors[o3 + 1] = base.g * multiplier
      colors[o3 + 2] = base.b * multiplier
    }
    colorAttr.needsUpdate = true
    visibleRef.current = visible
  }, [buffers, objects, filters, selectedIndex, hoveredIndex])

  // Leaving the scene (catalog swap, unmount) must not leave a stale tooltip or cursor.
  useEffect(
    () => () => {
      hoverStore.set(-1)
      document.body.style.cursor = 'auto'
    },
    [hoverStore, buffers],
  )

  const isPickable = (index: number | undefined): index is number =>
    typeof index === 'number' && index >= 0 && index < objects.length && visibleRef.current[index] === 1

  const setHover = (index: number) => {
    if (index !== hoveredIndex) setHoveredIndex(index)
    hoverStore.set(index)
    document.body.style.cursor = index < 0 ? 'auto' : 'pointer'
  }

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (event.buttons) return // dragging the globe
    // Filtered-out points let the event fall through to whatever is behind them.
    const index = isPickable(event.index) ? event.index : -1
    if (index >= 0) {
      event.stopPropagation()
      tooltipRef.current?.setPosition(event.nativeEvent.clientX, event.nativeEvent.clientY)
    }
    setHover(index)
  }

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    // OrbitControls emits a click after a drag; only a genuine tap selects.
    if (event.delta > CLICK_TOLERANCE_PX) return
    if (!isPickable(event.index)) return
    event.stopPropagation()
    onSelect(objects[event.index].id)
  }

  const selected = selectedIndex >= 0 ? objects[selectedIndex] : null

  return (
    <>
      {/* Invisible, low-poly Earth: blocks picking satellites on the far side of the globe. */}
      <mesh
        geometry={occluderGeometry}
        onPointerMove={(event) => {
          event.stopPropagation()
          if (hoveredIndex !== -1) setHover(-1)
        }}
        onClick={(event) => {
          event.stopPropagation()
          if (event.delta <= CLICK_TOLERANCE_PX) onBackgroundClick()
        }}
      >
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>

      <points
        geometry={buffers.core}
        onPointerMove={handlePointerMove}
        onPointerOut={() => setHover(-1)}
        onClick={handleClick}
        frustumCulled={false}
      >
        <pointsMaterial
          vertexColors
          map={particleTexture}
          alphaMap={particleTexture}
          alphaTest={0.01}
          size={POINT_SIZE}
          sizeAttenuation
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>

      {halo && (
        <points geometry={buffers.halo} raycast={() => null} frustumCulled={false} renderOrder={2}>
          <pointsMaterial
            vertexColors
            map={particleTexture}
            alphaMap={particleTexture}
            alphaTest={0.005}
            size={HALO_SIZE}
            sizeAttenuation
            transparent
            opacity={HALO_OPACITY}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </points>
      )}

      {selected && (
        <>
          <group ref={markerRef} visible={false}>
            <points raycast={() => null} frustumCulled={false} renderOrder={4}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[markerPosition, 3]} />
              </bufferGeometry>
              <pointsMaterial
                map={particleTexture}
                alphaMap={particleTexture}
                alphaTest={0.01}
                size={0.34}
                sizeAttenuation
                transparent
                color="#ffffff"
                depthWrite={false}
                blending={THREE.AdditiveBlending}
                toneMapped={false}
              />
            </points>
            <points raycast={() => null} frustumCulled={false} renderOrder={3}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[markerPosition, 3]} />
              </bufferGeometry>
              <pointsMaterial
                map={particleTexture}
                alphaMap={particleTexture}
                alphaTest={0.005}
                size={0.72}
                sizeAttenuation
                transparent
                opacity={0.52}
                color={categoryColor(selected.categoryId)}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
                toneMapped={false}
              />
            </points>
          </group>
          <OrbitRing
            key={`${selected.id}:${catalog.version}`}
            propagator={propagator}
            index={selectedIndex}
            periodMin={selected.periodMin}
            color={categoryColor(selected.categoryId)}
          />
        </>
      )}
    </>
  )
}

/* ============================================================
   CAMERA RIG
   ------------------------------------------------------------
   - Selecting flies to the object once (the aim tracks the moving
     object during the flight, so it lands on it even at high warp).
   - Follow keeps the camera on the object's radial line every frame,
     smoothly, at whatever distance the user zooms to (rotation is
     handed back to OrbitControls when following stops).
   - Clearing the selection eases back out to the home distance.
   ============================================================ */

type ControlsLike = { enabled: boolean; enableRotate: boolean; update: () => void }

type Flight = {
  elapsed: number
  duration: number
  from: THREE.Spherical
  /** Fixed destination (home) or null to aim at the selected object. */
  to: THREE.Spherical | null
}

const FLIGHT_SECONDS = 1.65
const HOME_SECONDS = 0.95
const FOLLOW_RATE = 3.2
const FOLLOW_LOCK_RAD = 0.01

function flightDistanceFor(target: THREE.Vector3): number {
  return Math.min(Math.max(target.length() + 2.4, EARTH_RADIUS + 3), CAMERA_MAX_DISTANCE)
}

function CameraRig({
  enabled,
  selectedKey,
  follow,
  instant,
  selectedPosRef,
}: {
  enabled: boolean
  /** Changes when a different object is selected (null = none). */
  selectedKey: number | null
  follow: boolean
  instant: boolean
  selectedPosRef: RefObject<SelectedPosition>
}) {
  const get = useThree((s) => s.get)
  const home = useThree((s) => homeDistance(s.size.width / s.size.height))
  const flightRef = useRef<Flight | null>(null)
  const pendingRef = useRef<'select' | 'home' | null>(null)
  /** Follow has caught up with the object and now tracks it exactly. */
  const lockedRef = useRef(false)
  // Read lazily so a resize (e.g. a mobile keyboard opening) never starts a flight.
  const homeRef = useRef(home)
  useEffect(() => {
    homeRef.current = home
  }, [home])

  useEffect(() => {
    if (!enabled) return
    pendingRef.current = selectedKey === null ? 'home' : 'select'
    lockedRef.current = false
  }, [enabled, selectedKey])

  const scratch = useMemo(
    () => ({ to: new THREE.Spherical(), dir: new THREE.Vector3(), target: new THREE.Vector3() }),
    [],
  )

  useFrame((_, delta) => {
    if (!enabled) return
    const sel = selectedPosRef.current
    const { camera, controls } = get()
    const orbitControls = controls as unknown as ControlsLike | null
    if (orbitControls && orbitControls.enableRotate === follow) orbitControls.enableRotate = !follow

    const pending = pendingRef.current
    if (pending === 'home') {
      pendingRef.current = null
      const from = new THREE.Spherical().setFromVector3(camera.position)
      if (Math.abs(from.radius - homeRef.current) >= 0.5) {
        const to = new THREE.Spherical(homeRef.current, from.phi, from.theta)
        flightRef.current = { elapsed: 0, duration: instant ? 0 : HOME_SECONDS, from, to }
      }
    } else if (pending === 'select' && sel.valid) {
      pendingRef.current = null
      flightRef.current = {
        elapsed: 0,
        duration: instant ? 0 : FLIGHT_SECONDS,
        from: new THREE.Spherical().setFromVector3(camera.position),
        to: null,
      }
    }

    const flight = flightRef.current
    if (flight) {
      if (flight.to === null && !sel.valid) {
        // Target vanished mid-flight (deselected, catalog swap): hand control back.
        flightRef.current = null
        if (orbitControls) orbitControls.enabled = true
      } else {
        if (orbitControls) orbitControls.enabled = false
        flight.elapsed += delta
        const raw = flight.duration > 0 ? Math.min(flight.elapsed / flight.duration, 1) : 1
        const eased = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2
        const to = flight.to ?? scratch.to
        if (flight.to === null) {
          scratch.target.copy(sel.v)
          const distance = follow ? Math.max(camera.position.length(), flightDistanceFor(scratch.target)) : flightDistanceFor(scratch.target)
          to.setFromVector3(scratch.target.normalize().multiplyScalar(distance))
        }
        // Take the short way around.
        let deltaTheta = to.theta - flight.from.theta
        if (deltaTheta > Math.PI) deltaTheta -= Math.PI * 2
        if (deltaTheta < -Math.PI) deltaTheta += Math.PI * 2
        camera.position.setFromSphericalCoords(
          THREE.MathUtils.lerp(flight.from.radius, to.radius, eased),
          THREE.MathUtils.lerp(flight.from.phi, to.phi, eased),
          flight.from.theta + deltaTheta * eased,
        )
        camera.lookAt(0, 0, 0)
        if (raw >= 1) {
          flightRef.current = null
          if (orbitControls) {
            orbitControls.enabled = true
            orbitControls.update()
          }
        }
        return
      }
    }

    // No flight in progress: the user always has the controls (zoom works while following).
    if (orbitControls && !orbitControls.enabled) orbitControls.enabled = true

    if (follow && sel.valid) {
      const distance = camera.position.length()
      scratch.dir.copy(camera.position).divideScalar(distance)
      scratch.target.copy(sel.v).normalize()
      // Ease in once, then lock on: an exponential chase would trail a fast object
      // (a visible lag at high warp).
      if (!lockedRef.current && scratch.dir.angleTo(scratch.target) < FOLLOW_LOCK_RAD) lockedRef.current = true
      const k = instant || lockedRef.current ? 1 : 1 - Math.exp(-delta * FOLLOW_RATE)
      scratch.dir.lerp(scratch.target, k).normalize()
      camera.position.copy(scratch.dir).multiplyScalar(distance)
      camera.lookAt(0, 0, 0)
    } else {
      lockedRef.current = false
    }
  })

  return null
}

/* ============================================================
   INTRO PHASE STATE
   ============================================================ */

type IntroPhase = 'intro' | 'main'

/* ============================================================
   SCENE
   ============================================================ */

function Scene({
  phase,
  quality,
  reducedMotion,
  onEarthReady,
  onStarsReady,
  engine,
  filters,
  selectedId,
  follow,
  hoverStore,
  tooltipRef,
  onSelectSatellite,
  onBackgroundClick,
}: {
  phase: IntroPhase
  quality: QualityProfile
  reducedMotion: boolean
  onEarthReady?: () => void
  onStarsReady?: () => void
  engine: Engine | null
  filters: Filters
  selectedId: number | null
  follow: boolean
  hoverStore: HoverStore
  tooltipRef: RefObject<HoverTooltipHandle | null>
  onSelectSatellite: (id: number) => void
  onBackgroundClick: () => void
}) {
  const selectedPosRef = useRef<SelectedPosition>({ v: new THREE.Vector3(), valid: false })
  const selectedIndex = selectedId === null || !engine ? -1 : (engine.catalog.byId.get(selectedId) ?? -1)

  return (
    <>
      <color attach="background" args={['#01050d']} />
      <ambientLight intensity={0.24} />
      <hemisphereLight args={['#9ed9ff', '#01050d', 0.4]} />
      <SunLight />

      <Earth active={phase !== 'intro'} quality={quality} onReady={onEarthReady} />
      <Starfield quality={quality} onReady={onStarsReady} />

      {phase === 'main' && engine && (
        <SatellitesLayer
          key={engine.catalog.version}
          engine={engine}
          filters={filters}
          selectedIndex={selectedIndex}
          halo={quality.satelliteHalo}
          hoverStore={hoverStore}
          tooltipRef={tooltipRef}
          selectedPosRef={selectedPosRef}
          onSelect={onSelectSatellite}
          onBackgroundClick={onBackgroundClick}
        />
      )}

      <OrbitControls
        makeDefault
        enabled={phase === 'main' && controlsEnabled}
        enablePan={false}
        enableDamping
        dampingFactor={0.075}
        rotateSpeed={0.55}
        zoomSpeed={0.65}
        minDistance={3.2}
        maxDistance={CAMERA_MAX_DISTANCE}
        target={[0, 0, 0]}
        onStart={() => { document.body.style.cursor = 'grabbing' }}
        onEnd={() => { document.body.style.cursor = 'auto' }}
      />

      <CameraRig
        enabled={phase === 'main'}
        selectedKey={selectedIndex >= 0 ? selectedId : null}
        follow={follow && selectedIndex >= 0}
        instant={reducedMotion}
        selectedPosRef={selectedPosRef}
      />
    </>
  )
}

/* ============================================================
   INTRO WORDMARK OVERLAY
   ============================================================ */

function IntroWordmark({
  phase,
  onEnter,
  canEnter,
}: {
  phase: IntroPhase
  onEnter: () => void
  canEnter: boolean
}) {
  return (
    <div className={`intro-overlay ${phase === 'main' ? 'is-entered' : ''}`}>
      <div
        className={`intro-wordmark ${canEnter ? 'is-ready' : 'is-loading'}`}
        onClick={onEnter}
        role="button"
        tabIndex={phase === 'intro' ? 0 : -1}
        aria-disabled={!canEnter}
        aria-label="Enter Orbital Eye"
      >
        <div className="intro-title">ORBITAL&nbsp;&nbsp;EYE</div>

        <div className="intro-hint" aria-live="polite">
          {canEnter ? (
            <>
              <span className="intro-hint-desktop">Click or press Space to enter</span>
              <span className="intro-hint-mobile">Tap to enter</span>
            </>
          ) : (
            'Loading Earth…'
          )}
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   HOVER TOOLTIP (subscribes to the hover store, not App)
   ============================================================ */

const HOVER_LIVE_INTERVAL_MS = 1000

function HoverTooltipContainer({
  store,
  tooltipRef,
  engine,
}: {
  store: HoverStore
  tooltipRef: RefObject<HoverTooltipHandle | null>
  engine: Engine | null
}) {
  const index = useSyncExternalStore(store.subscribe, store.get, store.get)
  const object = engine && index >= 0 ? (engine.catalog.objects[index] ?? null) : null
  const [live, setLive] = useState<{ index: number; value: LiveState } | null>(null)

  useEffect(() => {
    if (!engine || index < 0) return
    let cancelled = false
    const read = () => {
      engine.propagator
        .getLiveState(index, clock.now())
        .then((value) => {
          if (!cancelled) setLive({ index, value })
        })
        .catch(() => {})
    }
    read()
    const id = window.setInterval(read, HOVER_LIVE_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [engine, index])

  return (
    <HoverTooltip
      ref={tooltipRef}
      object={object}
      live={live && live.index === index ? live.value : null}
      color={object ? categoryColor(object.categoryId) : undefined}
    />
  )
}

/* ============================================================
   AI ASSISTANT PANEL (right) — wired to backend AI exploration
   ============================================================ */

const AI_MAX_INPUT = 500
const AI_MAX_MESSAGES = 50

function describeAIResult(data: AICommandResult): string {
  if (data.success === false || data.error) {
    return `Couldn't do that: ${data.error ?? 'the assistant returned no command'}. Try rephrasing.`
  }
  if (data.ai_response) return data.ai_response

  const payload = data.result?.data
  const count = payload?.total_count ?? payload?.results?.length
  if (typeof count === 'number') {
    return count === 0 ? 'No matching objects.' : `Found ${count} matching object${count === 1 ? '' : 's'}.`
  }
  return data.command ? `Done: ${data.command.replace(/_/g, ' ')}.` : 'Done.'
}

type ChatMessage = { id: number; role: 'assistant' | 'user'; text: string }

function AIPanel({
  mobileOpen,
  setMobileOpen,
  satelliteInfoOpen,
  onExecuteCommand,
}: {
  mobileOpen: boolean
  setMobileOpen: (v: boolean) => void
  satelliteInfoOpen: boolean
  onExecuteCommand: (result: AICommandResult) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 0,
      role: 'assistant',
      text: 'Ask about any satellite, orbit or category. I can find objects and point the camera at them.',
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const nextId = useRef(1)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // The reply arrives later; run the handler from that moment, not from send time.
  const executeRef = useRef(onExecuteCommand)
  useEffect(() => {
    executeRef.current = onExecuteCommand
  })

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages])

  const push = (role: ChatMessage['role'], text: string) => {
    const id = nextId.current
    nextId.current += 1
    setMessages((m) => [...m, { id, role, text }].slice(-AI_MAX_MESSAGES))
  }

  const send = async () => {
    const text = input.trim().slice(0, AI_MAX_INPUT)
    if (!text || loading) return
    setLoading(true)
    push('user', text)
    setInput('')

    try {
      const data = await api.explore({ request: text })
      push('assistant', describeAIResult(data))
      if (data.command && data.success !== false) executeRef.current(data)
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      push(
        'assistant',
        status === 429
          ? 'Too many questions in a short time. Wait a minute and try again.'
          : "Couldn't reach the assistant. Check that the backend is running.",
      )
    } finally {
      setLoading(false)
      inputRef.current?.focus({ preventScroll: true })
    }
  }

  return (
    <>
      {!mobileOpen && (
        <button className="ai-launcher" onClick={() => setMobileOpen(true)} aria-label="Open AI assistant">
          <span className="ai-launcher-orb" />
          <span className="ai-launcher-copy">
            <span className="ai-launcher-title">AI assistant</span>
            <span className="ai-launcher-prompt">Ask about satellites</span>
          </span>
        </button>
      )}
      <div
        className={`side-panel ai-panel ${mobileOpen ? 'is-open' : ''} ${satelliteInfoOpen ? 'has-satellite-info' : ''}`}
        aria-hidden={!mobileOpen}
      >
        <div className="panel-header">
          <span>AI assistant</span>
          <button
            className="panel-mobile-close ai-close-button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close AI assistant"
            title="Close AI assistant"
          >
            ×
          </button>
        </div>

        <div className="ai-messages" ref={listRef} role="log" aria-live="polite">
          {messages.map((m) => (
            <div key={m.id} className={`ai-msg ai-msg-${m.role}`}>
              {m.text}
            </div>
          ))}
        </div>

        <form
          className="ai-input-row"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the assistant…"
            aria-label="Message the AI assistant"
            maxLength={AI_MAX_INPUT}
            readOnly={loading}
            aria-busy={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            {loading ? '…' : 'Send'}
          </button>
        </form>
      </div>
    </>
  )
}

/* ============================================================
   APP
   ============================================================ */

type CatalogState =
  | { status: 'loading'; attempt: number }
  | { status: 'ready'; attempt: number; catalog: LoadedCatalog }
  | { status: 'error'; attempt: number; message: string }

/** Turns a catalog load failure into a short, specific reason for the rail. */
function describeCatalogError(message: string): string {
  const status = /\[(\d{3})\]/.exec(message)?.[1]
  if (status === '404') return 'the server has no catalog endpoint. Restart the backend so it runs the current code.'
  if (status === '503') return 'the server is up but its database is unavailable.'
  if (status) return `the server answered with error ${status}.`
  if (/abort|timeout/i.test(message)) return 'the server took too long to answer.'
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "the server can't be reached."
  return 'the server sent data this app can’t read.'
}

type DetailsState = {
  id: number
  attempt: number
  data: ObjectDetails | null
  error: string | null
}

export default function App() {
  const [quality] = useState(detectQuality)
  const reducedMotion = usePrefersReducedMotion()
  const [dpr, setDpr] = useState(quality.dpr[1])
  const tickHz = quality.tier === 'low' ? 4 : 8

  const [earthReady, setEarthReady] = useState(false)
  const [starsReady, setStarsReady] = useState(false)
  const [phase, setPhase] = useState<IntroPhase>('intro')

  const [forceReady, setForceReady] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setForceReady(true), 2500)
    return () => window.clearTimeout(t)
  }, [])

  const canEnter = starsReady || earthReady || forceReady

  /* ---------- catalog (IndexedDB stale-while-revalidate) ---------- */

  const [filters, setFilters] = useState<Filters>(ALL_FILTERS)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [follow, setFollow] = useState(false)
  /** A deep-linked NORAD number that isn't in the catalog (re-entered or unknown). */
  const [missingNorad, setMissingNorad] = useState<number | null>(null)

  // 4. A newer catalog may no longer contain the selected object.
  const onCatalogUpdate = useEffectEvent((next: LoadedCatalog) => {
    if (selectedId !== null && !next.byId.has(selectedId)) {
      setSelectedId(null)
      setFollow(false)
    }
  })

  // Deep link: select ?sat=<NORAD> once, the first time a catalog is available.
  const deepLinkHandled = useRef(false)
  const applyDeepLink = useEffectEvent((loaded: LoadedCatalog) => {
    if (deepLinkHandled.current) return
    deepLinkHandled.current = true
    const norad = readDeepLinkNorad()
    if (norad === null) return
    const index = loaded.byNorad.get(norad)
    if (index === undefined) {
      writeDeepLink(null)
      setMissingNorad(norad)
      return
    }
    const o = loaded.objects[index]
    setSelectedId(o.id)
    setFilters((f) => (passesFilters(o, f) ? f : ALL_FILTERS))
  })

  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: 'loading', attempt: 0 })

  useEffect(() => {
    const controller = new AbortController()
    loadCatalog({
      signal: controller.signal,
      onUpdate: (next) => {
        setCatalogState({ status: 'ready', attempt: catalogAttempt, catalog: next })
        onCatalogUpdate(next)
      },
    })
      .then((catalog) => {
        setCatalogState({ status: 'ready', attempt: catalogAttempt, catalog })
        applyDeepLink(catalog)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        console.error('Failed to load catalog:', err)
        setCatalogState({
          status: 'error',
          attempt: catalogAttempt,
          message: err instanceof Error ? err.message : String(err),
        })
      })
    return () => controller.abort()
  }, [catalogAttempt])

  // A retry is "loading" until the new attempt settles.
  const catalogLoading = catalogState.status === 'loading' || catalogState.attempt !== catalogAttempt
  const catalog = catalogState.status === 'ready' ? catalogState.catalog : null
  const catalogError = !catalogLoading && catalogState.status === 'error' ? catalogState.message : null
  const retryCatalog = useCallback(() => setCatalogAttempt((n) => n + 1), [])

  /* ---------- propagator (one per catalog version) ---------- */

  const [engine, setEngine] = useState<Engine | null>(null)
  const [engineError, setEngineError] = useState<{ catalog: LoadedCatalog; message: string } | null>(null)

  // A new propagator is primed off-screen until it has its first positions, and only
  // then replaces the current engine, so a catalog swap never blanks the field. Once
  // promoted, its disposal belongs to the effect below (when it is replaced/unmounted).
  useEffect(() => {
    if (!catalog) return
    let promoted = false
    let primeTimer = 0
    const propagator: Propagator = new Propagator(catalog.omm, {
      tickHz,
      invalidFill: 'origin',
      onReady: () => {
        const prime = () => {
          propagator.setTime(clock.now())
          if (propagator.hasPositions) {
            promoted = true
            setEngine({ catalog, propagator })
          } else {
            primeTimer = window.setTimeout(prime, 40)
          }
        }
        prime()
      },
      onError: (message) => {
        console.error('Propagator failed:', message)
        setEngineError({ catalog, message })
      },
    })
    return () => {
      window.clearTimeout(primeTimer)
      if (!promoted) propagator.dispose()
    }
  }, [catalog, tickHz])

  useEffect(() => {
    if (!engine) return
    return () => engine.propagator.dispose()
  }, [engine])

  const propagationError = engineError && engineError.catalog === catalog ? engineError.message : null

  /* ---------- clock ---------- */

  const timeState = useClockState()

  /* ---------- filters ---------- */

  const [filtersOpen, setFiltersOpen] = useState(false)
  const objects = catalog?.objects
  const searchIndex = useMemo(() => buildSearchIndex(objects ?? []), [objects])
  const breakdown = useMemo(() => computeBreakdown(objects ?? []), [objects])
  const counts = useMemo(() => computeFacetCounts(objects ?? [], filters), [objects, filters])

  /* ---------- selection ---------- */

  const [aiOpen, setAiOpen] = useState(false)

  const selectedIndex = selectedId !== null && catalog ? (catalog.byId.get(selectedId) ?? -1) : -1
  const selected = selectedIndex >= 0 && catalog ? catalog.objects[selectedIndex] : null

  /** Selecting an object also makes sure the filters show it. */
  const select = useCallback(
    (id: number) => {
      setSelectedId(id)
      setMissingNorad(null)
      const index = catalog?.byId.get(id)
      const o = index === undefined ? undefined : catalog?.objects[index]
      if (o) {
        setFilters((f) => {
          if (passesFilters(o, f)) return f
          return {
            categories: new Set(f.categories).add(o.categoryId),
            regimes: new Set(f.regimes).add(o.regime),
            types: new Set(f.types).add(o.objectType),
          }
        })
      }
    },
    [catalog],
  )

  const clearSelection = useCallback(() => {
    setSelectedId(null)
    setFollow(false)
  }, [])

  const selectObject = useCallback((o: CatalogObject) => select(o.id), [select])

  // Keep the address bar in sync with the selection (no history entries), once the
  // deep link (if any) has been applied.
  const selectedNorad = selected?.norad ?? null
  useEffect(() => {
    if (!deepLinkHandled.current) return
    writeDeepLink(selectedNorad)
  }, [selectedNorad])

  // Escape closes the details (inputs keep Escape for themselves).
  useEffect(() => {
    if (selectedId === null) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      clearSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedId, clearSelection])

  /* ---------- details / media (IndexedDB-cached, only for the selection) ---------- */

  const [detailsAttempt, setDetailsAttempt] = useState(0)
  const [detailsState, setDetailsState] = useState<DetailsState | null>(null)

  useEffect(() => {
    if (selectedId === null) return
    let cancelled = false
    getObjectDetails(selectedId)
      .then((data) => {
        if (!cancelled) setDetailsState({ id: selectedId, attempt: detailsAttempt, data, error: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.warn('Failed to load object details:', err)
        setDetailsState({
          id: selectedId,
          attempt: detailsAttempt,
          data: null,
          error: "Couldn't load extra details for this object.",
        })
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, detailsAttempt])

  const detailsCurrent =
    detailsState && detailsState.id === selectedId && detailsState.attempt === detailsAttempt ? detailsState : null
  const detailsLoading = selectedId !== null && detailsCurrent === null
  const retryDetails = useCallback(() => setDetailsAttempt((n) => n + 1), [])
  const media = useMemo(
    () => detailsCurrent?.data?.media.map((m) => ({ label: m.media_type, url: m.url })),
    [detailsCurrent],
  )
  const description = detailsCurrent?.data?.metadata?.description ?? null

  /* ---------- live values for the details panel ----------
     SatelliteDetails polls getLive(id) synchronously at 2 Hz; the exact SGP4 state
     comes from the worker asynchronously, so each poll returns the latest answer
     and asks for the next one (at most one request in flight). */

  const liveCache = useRef<{ key: string; value: LiveState | null; inflight: boolean }>({
    key: '',
    value: null,
    inflight: false,
  })
  const getLive = useCallback(
    (id: number): LiveState | null => {
      const index = engine?.catalog.byId.get(id)
      if (!engine || index === undefined) return null
      const key = `${engine.catalog.version}:${id}`
      const cache = liveCache.current
      if (cache.key !== key) {
        cache.key = key
        cache.value = null
        cache.inflight = false
      }
      if (!cache.inflight) {
        cache.inflight = true
        engine.propagator
          .getLiveState(index, clock.now())
          .then((value) => {
            if (cache.key === key) cache.value = value
          })
          .catch(() => {
            if (cache.key === key) cache.value = null
          })
          .finally(() => {
            if (cache.key === key) cache.inflight = false
          })
      }
      return cache.value
    },
    [engine],
  )

  /* ---------- assistant ---------- */

  const executeAICommand = (cmdResult: AICommandResult) => {
    const { command, result } = cmdResult
    const data = result?.data
    const objectId = data?.object?.object_id ?? data?.object_id ?? null
    const firstResultId = data?.results?.find((r) => catalog?.byId.has(r.object_id))?.object_id ?? null
    const known = (id: number | null): id is number => id !== null && catalog?.byId.has(id) === true

    switch (command) {
      case 'follow_object':
        if (known(objectId)) {
          select(objectId)
          setFollow(true)
        }
        break
      case 'focus_object':
      case 'show_orbit':
      case 'open_information_panel':
        if (known(objectId)) select(objectId)
        break
      case 'find_object':
        if (known(firstResultId)) select(firstResultId)
        break
      case 'filter_objects': {
        const filterCategory = data?.category
        if (filterCategory !== undefined && CATEGORY_BY_ID.has(filterCategory)) {
          setFilters({ ...ALL_FILTERS, categories: new Set([filterCategory]) })
        }
        if (known(firstResultId)) select(firstResultId)
        break
      }
      default:
        break
    }
  }

  /* ---------- time controls ---------- */

  const onPlayPause = useCallback(() => {
    if (clock.state.warp === 0) clock.play()
    else clock.pause()
  }, [])
  const onWarpChange = useCallback((warp: number) => clock.setWarp(warp), [])
  const onNow = useCallback(() => clock.goLive(), [])

  /* ---------- hover ---------- */

  const [hoverStore] = useState(createHoverStore)
  const tooltipRef = useRef<HoverTooltipHandle>(null)

  /* ---------- intro ---------- */

  const handleEnter = () => {
    if (phase !== 'intro' || !canEnter) return
    setPhase('main')
  }

  // Space/Enter only mean "enter" on the intro screen; afterwards keys belong to inputs.
  useEffect(() => {
    if (phase !== 'intro' || !canEnter) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        setPhase('main')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [phase, canEnter])

  const pointsThreshold = quality.tier === 'high' ? 0.08 : 0.12

  if (!quality.webgl) {
    return (
      <main className="earth-experience">
        <div className="error-message" role="alert" style={{ margin: '2rem' }}>
          Orbital Eye needs WebGL, which this browser or device has turned off. Enable hardware
          acceleration or open the page in a current version of Chrome, Firefox, Safari or Edge.
        </div>
      </main>
    )
  }

  const railStatus = catalogError ? (
    <>
      Couldn't load the satellite catalog: {describeCatalogError(catalogError)}{' '}
      <button type="button" className="oe-link-btn" onClick={retryCatalog}>
        Retry
      </button>
    </>
  ) : propagationError ? (
    <>Couldn't start orbit propagation in this browser.</>
  ) : catalogLoading ? (
    <>Loading the satellite catalog…</>
  ) : catalog && !engine ? (
    <>Computing orbits…</>
  ) : missingNorad !== null && selectedId === null ? (
    <>NORAD {missingNorad} isn't being tracked — it may have re-entered.</>
  ) : null

  const mainClass = [
    'earth-experience',
    phase === 'main' ? 'is-main' : '',
    quality.tier === 'low' ? 'low-power' : '',
    aiOpen ? 'ai-open' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <main className={mainClass}>
      <div className="earth-canvas-wrap">
        <Canvas
          camera={{ position: [0, 0, homeDistance(window.innerWidth / window.innerHeight)], fov: CAMERA_FOV, near: 0.1, far: 250 }}
          dpr={dpr}
          gl={{
            antialias: quality.antialias,
            powerPreference: quality.tier === 'low' ? 'default' : 'high-performance',
            stencil: false,
          }}
          raycaster={{
            params: {
              Mesh: {},
              Line: { threshold: 1 },
              LOD: {},
              Points: { threshold: pointsThreshold },
              Sprite: {},
            },
          }}
          onPointerMissed={() => {
            if (phase === 'main') clearSelection()
          }}
        >
          {/* Drop resolution when the frame rate can't keep up. */}
          <PerformanceMonitor onDecline={() => setDpr(quality.dpr[0])} />
          <Scene
            phase={phase}
            quality={quality}
            reducedMotion={reducedMotion}
            onEarthReady={() => setEarthReady(true)}
            onStarsReady={() => setStarsReady(true)}
            engine={engine}
            filters={filters}
            selectedId={selectedId}
            follow={follow}
            hoverStore={hoverStore}
            tooltipRef={tooltipRef}
            onSelectSatellite={select}
            onBackgroundClick={clearSelection}
          />
        </Canvas>
      </div>

      <div className="earth-vignette" />
      <div className="earth-reveal-mask" />

      <IntroWordmark phase={phase} onEnter={handleEnter} canEnter={canEnter} />

      {phase === 'main' && (
        <>
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
            decayed={catalog?.decayedObjects ?? 0}
            skipped={catalog?.skippedObjects ?? 0}
            generatedAt={catalog?.generatedAt ?? null}
            loading={!catalog}
          />

          <Rail
            filtersOpen={filtersOpen}
            onFiltersOpenChange={setFiltersOpen}
            activeFilterCount={activeFilterCount(filters)}
            status={railStatus}
            search={<SearchBox index={searchIndex} onSelect={selectObject} colorFor={categoryColor} />}
            filters={
              <FilterPanel
                categories={CATEGORIES}
                filters={filters}
                counts={counts}
                onChange={setFilters}
                onReset={() => setFilters(ALL_FILTERS)}
                objects={catalog?.objects}
                selectedId={selectedId}
                onSelectObject={select}
              />
            }
          />

          {selected && (
            <SatelliteDetails
              key={selected.id}
              object={selected}
              category={CATEGORY_BY_ID.get(selected.categoryId)}
              getLive={engine ? getLive : undefined}
              simTimeMs={timeState.simTimeMs}
              following={follow}
              onFollowChange={setFollow}
              onClose={clearSelection}
              shareUrl={shareUrlFor(selected.norad)}
              media={media}
              description={description}
              sanitizeUrl={safeExternalUrl}
              loading={detailsLoading}
              error={detailsCurrent?.error ?? null}
              onRetry={retryDetails}
            />
          )}

          <TimeControls
            time={timeState}
            getSimTimeMs={clock.now}
            onPlayPause={onPlayPause}
            onWarpChange={onWarpChange}
            onNow={onNow}
          />

          <AIPanel
            mobileOpen={aiOpen}
            setMobileOpen={setAiOpen}
            satelliteInfoOpen={selected !== null}
            onExecuteCommand={executeAICommand}
          />

          <HoverTooltipContainer store={hoverStore} tooltipRef={tooltipRef} engine={engine} />

          <div className="earth-controls-hint">Drag to rotate · Scroll to zoom</div>
        </>
      )}
    </main>
  )
}
