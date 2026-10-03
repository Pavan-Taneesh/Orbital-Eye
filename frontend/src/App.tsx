import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { FormEvent, MutableRefObject } from 'react'
import * as THREE from 'three'
import { api, type ObjectSummary, type StateResponse, type ObjectDetails, type MediaResponse, type AICommandResult } from './lib/types'
import {
  buildSatrecFromElements,
  propagateToEcef,
  generateOrbitPath,
  getOrbitalPeriodMinutes,
  fetchOrbitalElements,
  type OrbitalElements
} from './lib/orbital'

const EARTH_RADIUS = 2.2
const EARTH_RADIUS_KM = 6371

// Scale factor: backend returns ECEF position in km, Three.js uses EARTH_RADIUS units
const ECEF_TO_THREE_SCALE = EARTH_RADIUS / EARTH_RADIUS_KM

// Keep the known-good rotation speed.
const EARTH_ROTATION_SPEED = 0.018

function loadTexture(
  loader: THREE.TextureLoader,
  path: string,
): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      path,
      resolve,
      undefined,
      reject,
    )
  })
}

/* ============================================================
   SATELLITE DATA — loaded from backend API
   ============================================================ */

type Category = {
  id: string
  name: string
  color: string
  backendCategoryId: number
}

type SatelliteDef = {
  id: string
  name: string
  categoryId: string // frontend category ID
  backendCategoryId: number
  noradId: number
  objectId: number
}

// Map backend category_id (1-7) to frontend category IDs
// Backend categories:
// 1: Space Stations
// 2: Navigation
// 3: Communication
// 4: Weather
// 5: Scientific
// 6: Rocket Bodies
// 7: Space Debris
const BACKEND_TO_FRONTEND_CATEGORY: Record<number, string> = {
  1: 'stations',    // Space Stations
  2: 'navigation',  // Navigation
  3: 'communication', // Communication
  4: 'weather',     // Weather
  5: 'scientific',  // Scientific
  6: 'rocket-bodies', // Rocket Bodies
  7: 'debris',      // Space Debris
}

// Frontend category definitions matching backend 7 categories
const CATEGORIES: Category[] = [
  { id: 'stations', name: 'Space Stations', color: '#FFD700', backendCategoryId: 1 },
  { id: 'navigation', name: 'Navigation', color: '#00BFFF', backendCategoryId: 2 },
  { id: 'communication', name: 'Communication', color: '#FF6347', backendCategoryId: 3 },
  { id: 'weather', name: 'Weather', color: '#32CD32', backendCategoryId: 4 },
  { id: 'scientific', name: 'Scientific', color: '#9370DB', backendCategoryId: 5 },
  { id: 'rocket-bodies', name: 'Rocket Bodies', color: '#FF8C00', backendCategoryId: 6 },
  { id: 'debris', name: 'Space Debris', color: '#808080', backendCategoryId: 7 },
]

function categoryColor(categoryId: string): string {
  return CATEGORIES.find((c) => c.id === categoryId)?.color ?? '#ffffff'
}

function mapObjectSummaryToSatellite(obj: ObjectSummary): SatelliteDef {
  const frontendCategoryId = BACKEND_TO_FRONTEND_CATEGORY[obj.category_id] ?? 'scientific'

  return {
    id: `obj-${obj.object_id}`,
    name: obj.name,
    categoryId: frontendCategoryId,
    backendCategoryId: obj.category_id,
    noradId: obj.norad_id,
    objectId: obj.object_id,
  }
}

/* ============================================================
   NIGHT-SIDE CITY LIGHTS
   ============================================================ */

function NightLights({
  texture,
  sunDirection,
  revealRef,
}: {
  texture: THREE.Texture
  sunDirection: THREE.Vector3
  revealRef: { current: number }
}) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        nightMap: { value: texture },
        sunDirection: { value: sunDirection },
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
          float sunlight = dot(normalize(vWorldNormal), normalize(sunDirection));
          float nightFactor = smoothstep(0.16, -0.28, sunlight);
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
    })
  }, [texture, sunDirection])

  useFrame(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.reveal.value = revealRef.current
    }
  })

  return (
    <mesh scale={1.0015}>
      <sphereGeometry args={[EARTH_RADIUS, 192, 192]} />
      <primitive object={material} attach="material" ref={materialRef} />
    </mesh>
  )
}

/* ============================================================
   ATMOSPHERE
   ============================================================ */

function Atmosphere({ revealRef }: { revealRef: { current: number } }) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
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
    })
  }, [])

  useFrame(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.reveal.value = revealRef.current
    }
  })

  return (
    <mesh scale={1.013}>
      <sphereGeometry args={[EARTH_RADIUS, 160, 160]} />
      <primitive object={material} attach="material" ref={materialRef} />
    </mesh>
  )
}

/* ============================================================
   EARTH
   ============================================================ */

function Earth({ active, onReady }: { active: boolean; onReady?: () => void }) {
  const earthGroup = useRef<THREE.Group>(null)
  const dayMaterialRef = useRef<THREE.MeshStandardMaterial>(null)
  const cloudMaterialRef = useRef<THREE.MeshStandardMaterial>(null)

  const revealRef = useRef(0)
  const revealStart = useRef<number | null>(null)

  const [textures, setTextures] = useState<{
    day: THREE.Texture
    night: THREE.Texture
    cloud: THREE.Texture
    normal: THREE.Texture
  } | null>(null)

  const { gl } = useThree()

  const sunDirection = useMemo(
    () => new THREE.Vector3(-7.2, 2.7, -1.8).normalize(),
    [],
  )

  useEffect(() => {
    const loader = new THREE.TextureLoader()
    let active = true

    Promise.all([
        loadTexture(loader, '/textures/8k_earth_daymap.jpg'),
        loadTexture(loader, '/textures/8k_earth_nightmap.jpg'),
        loadTexture(loader, '/textures/8k_earth_clouds.jpg'),
        loadTexture(loader, '/textures/8k_earth_normal_map.png'),
      ])
        .then(([day, night, cloud, normal]) => {
          if (!active) return

          const anisotropy = Math.min(16, gl.capabilities.getMaxAnisotropy())

          day.colorSpace = THREE.SRGBColorSpace
          night.colorSpace = THREE.SRGBColorSpace
          cloud.colorSpace = THREE.SRGBColorSpace
          normal.colorSpace = THREE.NoColorSpace

          for (const texture of [day, night, cloud, normal]) {
            texture.anisotropy = anisotropy
            texture.wrapS = THREE.RepeatWrapping
            texture.wrapT = THREE.ClampToEdgeWrapping
            texture.minFilter = THREE.LinearMipmapLinearFilter
            texture.magFilter = THREE.LinearFilter
            texture.needsUpdate = true
          }

          setTextures({ day, night, cloud, normal })
          onReady?.()
        })
      .catch((error) => {
        console.error('Failed to load Earth textures:', error)
      })

    return () => {
      active = false
    }
  }, [gl, onReady])

  useFrame((state, delta) => {
    if (!earthGroup.current) return

    earthGroup.current.rotation.y += delta * EARTH_ROTATION_SPEED

    if (!active) {
      earthGroup.current.scale.setScalar(0.001)
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
    // A tiny scale settle keeps the reveal cinematic without the old "drop".
    const scale = 0.96 + eased * 0.04
    earthGroup.current.scale.setScalar(scale)

    revealRef.current = eased

    if (dayMaterialRef.current) dayMaterialRef.current.opacity = eased
    if (cloudMaterialRef.current) cloudMaterialRef.current.opacity = 0.44 * eased
  })

  if (!textures) return null

  return (
    <group ref={earthGroup} rotation={[0, Math.PI, 0]}>
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS, 192, 192]} />
        <meshStandardMaterial
          ref={dayMaterialRef}
          map={textures.day}
          normalMap={textures.normal}
          normalScale={new THREE.Vector2(0.65, 0.65)}
          roughness={0.82}
          metalness={0}
          transparent
          opacity={0}
        />
      </mesh>

      <NightLights texture={textures.night} sunDirection={sunDirection} revealRef={revealRef} />

      <mesh scale={1.007}>
        <sphereGeometry args={[EARTH_RADIUS, 160, 160]} />
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

      <Atmosphere revealRef={revealRef} />
    </group>
  )
}

/* ============================================================
   STARFIELD SKYBOX
   ============================================================ */

function Starfield({ onReady }: { onReady?: () => void }) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null)
  const materialRef = useRef<THREE.MeshBasicMaterial>(null)
  const revealStart = useRef<number | null>(null)

  useEffect(() => {
    const loader = new THREE.TextureLoader()
    let active = true

    loadTexture(loader, '/textures/8k_stars_milky_way.jpg')
      .then((tex) => {
        if (!active) return
        tex.colorSpace = THREE.SRGBColorSpace
        tex.mapping = THREE.EquirectangularReflectionMapping
        setTexture(tex)
        onReady?.()
      })
      .catch((error) => {
        console.error('Failed to load starfield texture:', error)
      })

    return () => {
      active = false
    }
  }, [onReady])

  useFrame((state) => {
    if (!texture || !materialRef.current) return

    if (revealStart.current === null) {
      revealStart.current = state.clock.elapsedTime
    }

    const elapsed = state.clock.elapsedTime - revealStart.current
    const raw = Math.min(1, elapsed / 1.8)
    const eased = 1 - Math.pow(1 - raw, 3)

    materialRef.current.opacity = 0.82 * eased
  })

  return (
    <>
      {texture && (
        <mesh rotation={[0, Math.PI / 2, 0]} renderOrder={0}>
          <sphereGeometry args={[90, 64, 64]} />
          <meshBasicMaterial
            ref={materialRef}
            map={texture}
            side={THREE.BackSide}
            toneMapped={false}
            opacity={0}
            transparent
          />
        </mesh>
      )}
    </>
  )
}

/* ============================================================
   SATELLITE ORBIT + DOT — REAL ORBITAL MECHANICS
   ============================================================ */

function ecefToWorldPosition(position: number[] | null): THREE.Vector3 | null {
  if (!position) return null
  const [x, y, z] = position
  return new THREE.Vector3(
    x * ECEF_TO_THREE_SCALE,
    y * ECEF_TO_THREE_SCALE,
    z * ECEF_TO_THREE_SCALE
  )
}

function getSatelliteWorldPosition(
  sat: SatelliteDef,
  selectedSatelliteState: StateResponse | null,
  satelliteCache: Map<number, { state?: StateResponse }>,
  currentSelectedId: string | null
): THREE.Vector3 | null {
  const objectId = sat.objectId

  if (selectedSatelliteState?.position && sat.id === currentSelectedId) {
    return ecefToWorldPosition(selectedSatelliteState.position)
  }

  const cached = satelliteCache.get(objectId)
  if (cached?.state?.position) {
    return ecefToWorldPosition(cached.state.position)
  }

  return null
}

interface SatelliteOrbitData {
  satrec: ReturnType<typeof buildSatrecFromElements>
  orbitPath: THREE.Vector3[]
  periodMinutes: number
  elements: OrbitalElements
}

const orbitDataCache = new Map<number, SatelliteOrbitData>()

async function loadOrbitData(objectId: number): Promise<SatelliteOrbitData | null> {
  if (orbitDataCache.has(objectId)) {
    return orbitDataCache.get(objectId) ?? null
  }

  const elements = await fetchOrbitalElements(objectId)
  if (!elements) return null

  try {
    const satrec = buildSatrecFromElements(elements)
    const now = new Date()
    const orbitPath = generateOrbitPath(satrec, now, 360)
    const periodMinutes = getOrbitalPeriodMinutes(satrec)

    const data: SatelliteOrbitData = { satrec, orbitPath, periodMinutes, elements }
    orbitDataCache.set(objectId, data)
    return data
  } catch {
    return null
  }
}

function SelectedOrbit({ 
  objectId,
  color 
}: { 
  objectId: number
  color: string
}) {
  const [orbitPath, setOrbitPath] = useState<THREE.Vector3[] | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort()
    }
    const controller = new AbortController()
    abortRef.current = controller

    // Clear orbit path when objectId changes (before loading new one)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrbitPath((prev) => prev === null ? null : null)
    
    loadOrbitData(objectId).then((data) => {
      if (controller.signal.aborted) return
      if (data) {
        setOrbitPath(data.orbitPath)
      }
    }).catch(() => {
      if (controller.signal.aborted) return
    })

    return () => {
      if (abortRef.current) {
        abortRef.current.abort()
      }
    }
  }, [objectId])

  const positionAttribute = useMemo(() => {
    if (!orbitPath || orbitPath.length === 0) return null
    const positions = new Float32Array(orbitPath.length * 3)
    orbitPath.forEach((p, i) => {
      positions[i * 3] = p.x
      positions[i * 3 + 1] = p.y
      positions[i * 3 + 2] = p.z
    })
    return new THREE.BufferAttribute(positions, 3)
  }, [orbitPath])

  if (!positionAttribute) return null

  return (
    <>
      <line>
        <bufferGeometry attach="geometry" attributes={{ position: positionAttribute }} />
        <lineBasicMaterial
          color={color}
          transparent
          opacity={0.76}
          depthWrite={false}
          toneMapped={false}
        />
      </line>
      <line scale={1.002}>
        <bufferGeometry attach="geometry" attributes={{ position: positionAttribute }} />
        <lineBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.14}
          depthWrite={false}
          toneMapped={false}
        />
      </line>
    </>
  )
}

function createSatelliteParticleTexture(): THREE.CanvasTexture {
  const size = 96
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
  texture.needsUpdate = true
  return texture
}

/* ============================================================
   HIGH-DENSITY SATELLITE FIELD
   ------------------------------------------------------------
   Keep the entire constellation in one GPU Points object. This is
   intentionally not one React/Three object per satellite: the same
   renderer can handle tens of thousands of points without mounting
   tens of thousands of components, materials, orbit geometries, and
   animation loops.
   ============================================================ */
function SatellitesLayer({
  activeCategories,
  selectedId,
  onSelect,
  onHover,
  positionsRef,
  satellites,
  selectedSatelliteState,
  satelliteCache,
  categoryObjects,
  categoryBulkPositions,
}: {
  activeCategories: Set<string>
  selectedId: string | null
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
  positionsRef: MutableRefObject<Map<string, THREE.Vector3>>
  satellites: SatelliteDef[]
  selectedSatelliteState: StateResponse | null
  satelliteCache: Map<number, { state?: StateResponse }>
  categoryObjects: Record<number, SatelliteDef[]>
  categoryBulkPositions: Record<number, { loadedCount: number; totalCount: number; hasMore: boolean; loading: boolean; page: number; objectIds: number[] }>
}) {
  const pointsRef = useRef<THREE.Points>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null)
  const draggedRef = useRef(false)
  const particleTexture = useMemo(() => createSatelliteParticleTexture(), [])
  const [selectedSatPosition, setSelectedSatPosition] = useState<THREE.Vector3 | null>(null)
  const simTimeRef = useRef<Date>(new Date())

  // Filter satellites to only those with real position data and active category
  // Includes both the active render set AND all category objects with valid positions from bulk loading
  const { visibleSatellites, positions, colors, positionsById, indexToSatId } = useMemo(() => {
    const visibleSatellites: SatelliteDef[] = []
    const indexToSatId: string[] = []
    const positionsList: number[] = []
    const colorsList: number[] = []
    const positionsById = new Map<string, THREE.Vector3>()
    const seenSatIds = new Set<string>()

    // Helper to add a satellite if it has a valid position and active category
    const addSatellite = (sat: SatelliteDef) => {
      if (!activeCategories.has(sat.categoryId)) return
      if (seenSatIds.has(sat.id)) return

      const pos = getSatelliteWorldPosition(sat, selectedSatelliteState, satelliteCache, selectedId)
      if (!pos) return

      seenSatIds.add(sat.id)
      visibleSatellites.push(sat)
      indexToSatId.push(sat.id)

      positionsList.push(pos.x, pos.y, pos.z)
      positionsById.set(sat.id, pos)

      const c = new THREE.Color(categoryColor(sat.categoryId))
      colorsList.push(c.r, c.g, c.b)
    }

    // First add satellites from the active render set (selected, hovered, etc.)
    satellites.forEach(addSatellite)

    // Then add all satellites from category objects that have bulk positions loaded
    activeCategories.forEach((catId) => {
      const backendCatId = CATEGORIES.find(c => c.id === catId)?.backendCategoryId
      if (!backendCatId) return

      const catObjects = categoryObjects[backendCatId] || []
      catObjects.forEach(addSatellite)
    })

    // Then add all satellites from category bulk positions (GPU-rendered points)
    // These are objects that have real position data from the bulk state API
    activeCategories.forEach((catId) => {
      const backendCatId = CATEGORIES.find(c => c.id === catId)?.backendCategoryId
      if (!backendCatId) return

      const bulk = categoryBulkPositions[backendCatId]
      if (!bulk || bulk.objectIds.length === 0) return

      bulk.objectIds.forEach((objectId) => {
        const cached = satelliteCache.get(objectId) as { satellite: SatelliteDef; state?: StateResponse; details?: ObjectDetails; media?: MediaResponse } | undefined
        if (!cached) return
        if (!cached.satellite) return
        if (!cached.state?.position) return

        addSatellite(cached.satellite)
      })
    })

    return {
      visibleSatellites,
      positions: new Float32Array(positionsList),
      colors: new Float32Array(colorsList),
      positionsById,
      indexToSatId,
    }
  }, [satellites, selectedId, selectedSatelliteState, satelliteCache, activeCategories, categoryObjects, categoryBulkPositions])

  useEffect(() => {
    positionsRef.current.clear()
    visibleSatellites.forEach((sat) => {
      const pos = positionsById.get(sat.id)
      if (pos) positionsRef.current.set(sat.id, pos)
    })
  }, [activeCategories, positionsById, positionsRef, visibleSatellites])

  useEffect(() => {
    if (!pointsRef.current) return
    const attribute = pointsRef.current.geometry.getAttribute('color') as THREE.BufferAttribute
    const array = attribute.array as Float32Array

    visibleSatellites.forEach((sat, index) => {
      const selected = sat.id === selectedId
      const hovered = index === hoveredIndex
      const base = new THREE.Color(selected || hovered ? '#ffffff' : categoryColor(sat.categoryId))
      const multiplier = selected ? 3.0 : hovered ? 2.1 : 1.72
      array[index * 3] = base.r * multiplier
      array[index * 3 + 1] = base.g * multiplier
      array[index * 3 + 2] = base.b * multiplier
    })
    attribute.needsUpdate = true
  }, [hoveredIndex, selectedId, visibleSatellites])

  useEffect(() => {
    if (pointsRef.current) {
      const material = pointsRef.current.material as THREE.PointsMaterial
      material.size = window.innerWidth <= 820 ? 0.195 : 0.17
    }
  }, [])

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
    const DRAG_THRESHOLD_PX = 7

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      pointerDownRef.current = { x: event.clientX, y: event.clientY }
      draggedRef.current = false
    }

    const handlePointerMove = (event: PointerEvent) => {
      const start = pointerDownRef.current
      if (!start) return

      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        draggedRef.current = true
        if (hoveredIndex !== null) setHoveredIndex(null)
        onHover(null)
        document.body.style.cursor = 'grabbing'
      }
    }

    const resetPointerInteraction = () => {
      pointerDownRef.current = null
      draggedRef.current = false
      setHoveredIndex(null)
      onHover(null)
      document.body.style.cursor = 'auto'
    }

    const handlePointerUp = () => {
      if (!pointerDownRef.current && !draggedRef.current) return
      pointerDownRef.current = null
      if (draggedRef.current) {
        setHoveredIndex(null)
        onHover(null)
        document.body.style.cursor = 'auto'
      }
      // Always clear the drag latch after pointer release so the next
      // genuine satellite click is never swallowed.
      draggedRef.current = false
    }

    const handleWheel = () => {
      // OrbitControls handles wheel zoom itself. A wheel gesture must not
      // inherit a previous drag state/cursor, otherwise the user can get
      // stuck in the grabbing state and need an extra click before another
      // satellite can be selected.
      resetPointerInteraction()
    }

    window.addEventListener('pointerdown', handlePointerDown, { passive: true })
    window.addEventListener('pointermove', handlePointerMove, { passive: true })
    window.addEventListener('pointerup', handlePointerUp, { passive: true })
    window.addEventListener('pointercancel', handlePointerUp, { passive: true })
    window.addEventListener('wheel', handleWheel, { passive: true })

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      window.removeEventListener('wheel', handleWheel)
    }
  }, [hoveredIndex, onHover])

  interface PointsPointerEvent {
  index?: number
  buttons: number
  stopPropagation: () => void
}

  const handlePointerMoveOnPoint = (event: PointsPointerEvent) => {
    if (draggedRef.current || event.buttons) {
      if (hoveredIndex !== null) setHoveredIndex(null)
      onHover(null)
      document.body.style.cursor = 'grabbing'
      return
    }

    const index = typeof event.index === 'number' ? event.index : null
    if (index === hoveredIndex) return
    setHoveredIndex(index)
    onHover(index === null ? null : indexToSatId[index] ?? null)
  }

  const handlePointerOut = () => {
    if (draggedRef.current) return
    setHoveredIndex(null)
    onHover(null)
    document.body.style.cursor = 'auto'
  }

  const handleClick = (event: PointsPointerEvent) => {
    event.stopPropagation()

    // OrbitControls can emit a click after a drag ends over a point. Only a
    // genuine short pointer gesture is allowed to change the selected satellite.
    if (draggedRef.current) {
      draggedRef.current = false
      setHoveredIndex(null)
      onHover(null)
      document.body.style.cursor = 'auto'
      return
    }

    const index = typeof event.index === 'number' ? event.index : -1
    if (index >= 0 && indexToSatId[index]) onSelect(indexToSatId[index])
  }

  return (
    <>
      <points
        ref={pointsRef}
        onPointerMove={handlePointerMoveOnPoint}
        onPointerOver={() => { document.body.style.cursor = 'pointer' }}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
        frustumCulled={false}
      >
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          vertexColors
          map={particleTexture}
          alphaMap={particleTexture}
          alphaTest={0.01}
          size={0.17}
          sizeAttenuation
          transparent
          opacity={1}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>

      <points raycast={() => null} frustumCulled={false} renderOrder={2}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          vertexColors
          map={particleTexture}
          alphaMap={particleTexture}
          alphaTest={0.005}
          size={0.46}
          sizeAttenuation
          transparent
          opacity={0.46}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>

      {selectedId && (() => {
        const selectedSat = satellites.find((sat) => sat.id === selectedId)
        if (!selectedSat) return null
        // Use animated position if available, otherwise fall back to static position
        const selectedPosition = selectedSatPosition ?? positionsById.get(selectedSat.id)
        if (!selectedPosition) return null
        return (
          <>
            <points position={[selectedPosition.x, selectedPosition.y, selectedPosition.z]} raycast={() => null} frustumCulled={false} renderOrder={4}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[new Float32Array([0, 0, 0]), 3]} />
              </bufferGeometry>
              <pointsMaterial
                map={particleTexture}
                alphaMap={particleTexture}
                alphaTest={0.01}
                size={0.34}
                sizeAttenuation
                transparent
                opacity={1}
                color="#ffffff"
                depthWrite={false}
                blending={THREE.AdditiveBlending}
                toneMapped={false}
              />
            </points>
            <points position={[selectedPosition.x, selectedPosition.y, selectedPosition.z]} raycast={() => null} frustumCulled={false} renderOrder={3}>
              <bufferGeometry>
                <bufferAttribute attach="attributes-position" args={[new Float32Array([0, 0, 0]), 3]} />
              </bufferGeometry>
              <pointsMaterial
                map={particleTexture}
                alphaMap={particleTexture}
                alphaTest={0.005}
                size={0.72}
                sizeAttenuation
                transparent
                opacity={0.52}
                color={categoryColor(selectedSat.categoryId)}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
                toneMapped={false}
              />
            </points>
            <SelectedOrbit objectId={selectedSat.objectId} color={categoryColor(selectedSat.categoryId)} />
          </>
        )
      })()}
    </>
  )
}

/* ============================================================
   CAMERA RIG — handles "fly to satellite" + live tracking
   ============================================================ */

function CameraRig({
  phase,
  selectedId,
  satellites,
  selectedSatelliteState,
  satelliteCache,
  setControlsEnabled
}: {
  phase: IntroPhase;
  selectedId: string | null;
  satellites: SatelliteDef[];
  selectedSatelliteState: StateResponse | null;
  satelliteCache: Map<number, { state?: StateResponse }>;
  setControlsEnabled: (enabled: boolean) => void;
}) {
  const { controls, camera } = useThree((s) => ({ controls: s.controls, camera: s.camera })) as unknown as {
    controls: { target: THREE.Vector3; update: () => void } | null
    camera: THREE.PerspectiveCamera
  }

  const flightRef = useRef<{
    active: boolean
    elapsed: number
    duration: number
    fromSpherical: THREE.Spherical
    toSpherical: THREE.Spherical
  } | null>(null)

  useEffect(() => {
    if (phase !== 'main' || !controls) return

    const current = new THREE.Spherical().setFromVector3(camera.position.clone())
    const destination = new THREE.Spherical()

    controls.target.set(0, 0, 0)

    if (selectedId) {
      const sat = satellites.find((item) => item.id === selectedId)
      if (!sat) return

      // Use authoritative position function - only fly if we have real position
      const satPosition = getSatelliteWorldPosition(sat, selectedSatelliteState, satelliteCache, selectedId)
      if (!satPosition) return // Wait for real position data

      const direction = satPosition.clone().normalize()
      const destinationPosition = direction.multiplyScalar(
        Math.max(satPosition.length() + 1.05, EARTH_RADIUS + 1.6),
      )
      destination.setFromVector3(destinationPosition)

      let deltaTheta = destination.theta - current.theta
      if (deltaTheta > Math.PI) deltaTheta -= Math.PI * 2
      if (deltaTheta < -Math.PI) deltaTheta += Math.PI * 2
      destination.theta = current.theta + deltaTheta

      flightRef.current = {
        active: true,
        elapsed: 0,
        duration: 1.65,
        fromSpherical: current,
        toSpherical: destination,
      }
      setControlsEnabled(false)
    } else {
      destination.set(10.5, current.phi, current.theta)
      flightRef.current = {
        active: true,
        elapsed: 0,
        duration: 0.95,
        fromSpherical: current,
        toSpherical: destination,
      }
      setControlsEnabled(false)
    }
  }, [phase, selectedId, controls, camera, satellites, selectedSatelliteState, satelliteCache, setControlsEnabled])

  useFrame((_, delta) => {
    if (phase !== 'main' || !controls) return

    controls.target.set(0, 0, 0)
    const flight = flightRef.current
    if (!flight?.active) {
      setControlsEnabled(true)
      controls.update()
      return
    }

    flight.elapsed += delta
    const raw = Math.min(flight.elapsed / flight.duration, 1)
    const eased = raw < 0.5
      ? 4 * raw * raw * raw
      : 1 - Math.pow(-2 * raw + 2, 3) / 2

    const spherical = new THREE.Spherical(
      THREE.MathUtils.lerp(flight.fromSpherical.radius, flight.toSpherical.radius, eased),
      THREE.MathUtils.lerp(flight.fromSpherical.phi, flight.toSpherical.phi, eased),
      THREE.MathUtils.lerp(flight.fromSpherical.theta, flight.toSpherical.theta, eased),
    )

    camera.position.setFromSpherical(spherical)
    camera.lookAt(0, 0, 0)
    controls.target.set(0, 0, 0)
    controls.update()

    if (raw >= 1) {
      flight.active = false
      camera.position.setFromSpherical(flight.toSpherical)
      camera.lookAt(0, 0, 0)
      controls.target.set(0, 0, 0)
      setControlsEnabled(true)
      controls.update()
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
  onEarthReady,
  onStarsReady,
  activeCategories,
  selectedId,
  onSelectSatellite,
  positionsRef,
  satellites,
  selectedSatelliteState,
  satelliteCache,
  categoryObjects,
  categoryBulkPositions,
  controlsEnabled,
  setControlsEnabled,
}: {
  phase: IntroPhase
  onEarthReady?: () => void
  onStarsReady?: () => void
  activeCategories: Set<string>
  selectedId: string | null
  onSelectSatellite: (id: string) => void
  positionsRef: MutableRefObject<Map<string, THREE.Vector3>>
  satellites: SatelliteDef[]
  selectedSatelliteState: StateResponse | null
  satelliteCache: Map<number, { state?: StateResponse }>
  categoryObjects: Record<number, SatelliteDef[]>
  categoryBulkPositions: Record<number, { loadedCount: number; totalCount: number; hasMore: boolean; loading: boolean; page: number; objectIds: number[] }>
  controlsEnabled: boolean
  setControlsEnabled: (enabled: boolean) => void
}) {
  return (
    <>
      <color attach="background" args={['#01050d']} />
      <ambientLight intensity={0.24} />
      <hemisphereLight args={['#9ed9ff', '#01050d', 0.4]} />
      <directionalLight position={[-7.2, 2.7, -1.8]} intensity={2.9} color="#ffffff" />

      <Earth active={phase !== 'intro'} onReady={onEarthReady} />
      <Starfield onReady={onStarsReady} />

      {phase === 'main' && (
        <SatellitesLayer
          activeCategories={activeCategories}
          selectedId={selectedId}
          onSelect={onSelectSatellite}
          onHover={() => {}}
          positionsRef={positionsRef}
          satellites={satellites}
          selectedSatelliteState={selectedSatelliteState}
          satelliteCache={satelliteCache}
          categoryObjects={categoryObjects}
          categoryBulkPositions={categoryBulkPositions}
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
        maxDistance={17}
        target={[0, 0, 0]}
        onStart={() => { document.body.style.cursor = 'grabbing' }}
        onEnd={() => { document.body.style.cursor = 'auto' }}
      />

      <CameraRig phase={phase} selectedId={selectedId} satellites={satellites} selectedSatelliteState={selectedSatelliteState} satelliteCache={satelliteCache} setControlsEnabled={setControlsEnabled} />
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
        tabIndex={0}
      >
        <div className="intro-title">ORBITAL&nbsp;&nbsp;EYE</div>

        <div className="intro-hint">
          {canEnter ? (
            <>
              <span className="intro-hint-desktop">CLICK OR PRESS SPACE TO ENTER</span>
              <span className="intro-hint-mobile">TAP TO ENTER</span>
            </>
          ) : (
            'LOADING…'
          )}
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   EXPLORATION SIDEBAR (left) — complete backend catalogue with virtualized loading
   ============================================================ */

function ExplorationSidebar({
  activeCategories,
  toggleCategory,
  mobileOpen,
  setMobileOpen,
  selectedId,
  onSelectSatellite,
  onClearSelection,
  satellites,
  catalogue,
  categoryPages,
  setCategoryPages,
  categoryLoading,
  setCategoryLoading,
  categoryObjects,
  categoryTotalCounts,
  loadCatalogueByCategory,
}: {
  activeCategories: Set<string>
  toggleCategory: (id: string) => void
  mobileOpen: boolean
  setMobileOpen: (v: boolean) => void
  selectedId: string | null
  onSelectSatellite: (id: string) => void
  onClearSelection: () => void
  satellites: SatelliteDef[]
  catalogue: {
    objects: SatelliteDef[];
    totalCount: number;
    loading: boolean;
    error: string | null;
    currentPage: number;
    pageSize: number;
  }
  categoryPages: Record<number, number>
  setCategoryPages: React.Dispatch<React.SetStateAction<Record<number, number>>>
  categoryLoading: Set<number>
  setCategoryLoading: React.Dispatch<React.SetStateAction<Set<number>>>
  categoryObjects: Record<number, SatelliteDef[]>
  categoryTotalCounts: Record<number, number>
  loadCatalogueByCategory: (categoryId: number, page: number) => Promise<void>
}) {
  // Load more objects for a specific category
  const loadMoreForCategory = async (backendCategoryId: number) => {
    if (categoryLoading.has(backendCategoryId)) return

    // If this category hasn't been loaded at all yet, load page 0
    // categoryPages stores the LAST successfully loaded page number
    // If category is not in categoryPages, it means page 0 hasn't been loaded
    const currentPage = categoryPages[backendCategoryId]
    const nextPage = currentPage === undefined ? 0 : currentPage + 1

    setCategoryLoading(prev => new Set(prev).add(backendCategoryId))

    try {
      await loadCatalogueByCategory(backendCategoryId, nextPage)
      setCategoryPages(prev => ({ ...prev, [backendCategoryId]: nextPage }))
    } finally {
      setCategoryLoading(prev => {
        const next = new Set(prev)
        next.delete(backendCategoryId)
        return next
      })
    }
  }

  return (
    <div className={`side-panel sidebar-panel ${mobileOpen ? 'is-open' : ''}`}>
      <div className="panel-header">
        <span>EXPLORATION</span>
        <span className="catalogue-total-count" style={{ fontSize: '9px', color: 'rgba(200,218,232,0.5)', fontFamily: 'Orbitron, sans-serif', letterSpacing: '0.1em' }}>
          {catalogue.totalCount.toLocaleString()} OBJECTS
        </span>
        <button
          className="panel-mobile-close"
          onClick={() => setMobileOpen(false)}
          aria-label="Close exploration"
          title="Close exploration"
        >
          ×
        </button>
      </div>

      <div className="exploration-search-wrap">
        <SatelliteSearch selectedId={selectedId} onGo={onSelectSatellite} onClear={onClearSelection} satellites={satellites} />
      </div>

      {catalogue.loading && <div className="loading-indicator">Loading catalogue…</div>}
      {catalogue.error && <div className="error-message">{catalogue.error}</div>}

      <div className="panel-scroll">
        {CATEGORIES.map((cat) => {
          const backendCatId = cat.backendCategoryId
          const sats = categoryObjects[backendCatId] || []
          const totalCount = categoryTotalCounts[backendCatId] || sats.length
          const active = activeCategories.has(cat.id)
          const loading = categoryLoading.has(backendCatId)
          const hasMore = sats.length < totalCount

          return (
            <div key={cat.id} className="category-group" data-category-id={backendCatId}>
              <label className="category-row">
                <input type="checkbox" checked={active} onChange={() => toggleCategory(cat.id)} />
                <span className="cat-dot" style={{ background: cat.color, boxShadow: `0 0 6px ${cat.color}` }} />
                <span className="cat-name">{cat.name}</span>
                <span className="cat-count">{totalCount.toLocaleString()}</span>
              </label>

              {active && (
                <div className="satellite-sublist">
                  {sats.map((sat) => (
                    <button
                      key={sat.id}
                      className={`satellite-item ${selectedId === sat.id ? 'is-selected' : ''}`}
                      onClick={() => onSelectSatellite(sat.id)}
                    >
                      <span className="sat-dot" style={{ background: cat.color }} />
                      {sat.name}
                      <span className="sat-norad" style={{ fontSize: '8px', color: 'rgba(200,218,232,0.5)', marginLeft: '6px', fontFamily: 'Orbitron, sans-serif', letterSpacing: '0.05em' }}>
                        NORAD {sat.noradId}
                      </span>
                    </button>
                  ))}
                  {hasMore && (
                    <div className="load-more-trigger" style={{ padding: '8px', textAlign: 'center' }}>
                      {loading ? (
                        <span className="loading-indicator" style={{ fontSize: '10px' }}>Loading…</span>
                      ) : (
                        <button
                          className="load-more-btn"
                          onClick={() => loadMoreForCategory(backendCatId)}
                          style={{
                            background: 'rgba(255,255,255,0.05)',
                            border: '1px solid rgba(160,200,230,0.2)',
                            borderRadius: '4px',
                            padding: '6px 12px',
                            color: '#bfe8ff',
                            fontSize: '9px',
                            fontFamily: 'Orbitron, sans-serif',
                            letterSpacing: '0.1em',
                            cursor: 'pointer',
                            width: '100%',
                          }}
                        >
                          {categoryPages[backendCatId] === undefined
                            ? `Load objects (${totalCount} total)`
                            : `Load more (${totalCount - sats.length} remaining)`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ============================================================
   AI ASSISTANT PANEL (right) — wired to backend AI exploration
   ============================================================ */

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
  const [messages, setMessages] = useState<{ role: 'assistant' | 'user'; text: string }[]>([
    {
      role: 'assistant',
      text: 'Ask me about any satellite, orbit, or category. I can fly the camera and select satellites for you.',
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const send = async () => {
    const text = input.trim()
    if (!text || loading) return
    setLoading(true)
    setMessages((m) => [...m, { role: 'user', text }])
    setInput('')

    try {
      const data = await api.explore({ request: text })
      const cmd = data.command ? `✓ Executed: ${data.command}` : '✓ Done'
      const detail = data.result ? ` — ${JSON.stringify(data.result).slice(0, 200)}` : ''
      setMessages((m) => [...m, { role: 'assistant', text: `${cmd}${detail}` }])
      if (data.command) {
        onExecuteCommand({ command: data.command, result: data.result })
      }
    } catch {
      setMessages((m) => [...m, { role: 'assistant', text: '✗ Request failed. Check backend connection.' }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {!mobileOpen && (
        <button className="ai-launcher" onClick={() => setMobileOpen(true)} aria-label="Open AI assistant">
          <span className="ai-launcher-orb" />
          <span className="ai-launcher-copy">
            <span className="ai-launcher-title">AI ASSISTANT</span>
            <span className="ai-launcher-prompt">CLICK TO OPEN</span>
          </span>
          <span className="ai-launcher-arrow" aria-hidden="true">↗</span>
        </button>
      )}
      <div className={`side-panel ai-panel ${mobileOpen ? 'is-open' : ''} ${satelliteInfoOpen ? 'has-satellite-info' : ''}`}>
      <div className="panel-header">
        <span>AI ASSISTANT</span>
        <button
          className="panel-mobile-close ai-close-button"
          onClick={() => setMobileOpen(false)}
          aria-label="Close AI assistant"
          title="Close AI assistant"
        >
          ×
        </button>
      </div>

      <div className="ai-messages">
        {messages.map((m, i) => (
          <div key={i} className={`ai-msg ai-msg-${m.role}`}>
            {m.text}
          </div>
        ))}
      </div>

      <div className="ai-input-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
          placeholder="Ask the assistant…"
          disabled={loading}
        />
        <button onClick={send} disabled={loading}>
          {loading ? '…' : 'Send'}
        </button>
      </div>
      </div>
    </>
  )
}

/* ============================================================
   SEARCH BAR — backend search API
   ============================================================ */

function SatelliteSearch({
  selectedId,
  onGo,
  onClear,
  satellites,
}: {
  selectedId: string | null
  onGo: (id: string) => void
  onClear: () => void
  satellites: SatelliteDef[]
}) {
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ObjectSummary[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRequestRef = useRef<AbortController | null>(null)

  const performSearch = async (q: string) => {
    if (!q.trim()) {
      setSearchResults([])
      setNotFound(false)
      return
    }

    // Cancel previous in-flight request
    if (searchRequestRef.current) {
      searchRequestRef.current.abort()
    }
    const controller = new AbortController()
    searchRequestRef.current = controller

    setSearchLoading(true)
    setSearchError(null)
    setSearchResults([])

    try {
      const data = await api.search({ q, signal: controller.signal })
      // Check if request was aborted
      if (controller.signal.aborted) return
      setSearchResults(data.results)
      setNotFound(data.results.length === 0)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      if (controller.signal.aborted) return
      setSearchError(err instanceof Error ? err.message : 'Search failed')
      setSearchResults([])
      setNotFound(true)
    } finally {
      if (!controller.signal.aborted) {
        setSearchLoading(false)
      }
    }
  }

  const handleQueryChange = (value: string) => {
    setQuery(value)
    setNotFound(false)

    // Clear previous debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    // Debounce search by 250ms
    if (value.trim()) {
      debounceRef.current = setTimeout(() => {
        performSearch(value)
      }, 250)
    } else {
      setSearchResults([])
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return

    // Clear debounce on explicit submit
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    await performSearch(q)
  }

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
      if (searchRequestRef.current) {
        searchRequestRef.current.abort()
      }
    }
  }, [])

  const selectedSat = selectedId ? satellites.find((s) => s.id === selectedId) : null

  return (
    <form className="satellite-search" onSubmit={submit}>
      <input
        value={query}
        onChange={(e) => {
          handleQueryChange(e.target.value)
        }}
        onKeyDown={(e) => {
          // Keep OrbitControls / the Canvas from consuming Enter while the
          // search field is focused. Submit the form immediately.
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder="Search satellite name…"
      />
      <button type="submit" aria-label="Search satellite" disabled={searchLoading}>
        {searchLoading ? 'Searching…' : 'ENTER'}
      </button>

      {selectedSat && (
        <button
          type="button"
          className="clear-btn"
          onClick={() => {
            onClear()
            setQuery('')
            setSearchResults([])
          }}
        >
          ✕ {selectedSat.name}
        </button>
      )}

      {searchError && <span className="search-not-found">{searchError}</span>}

      {searchLoading && !searchError && (
        <span className="search-not-found">Loading search results…</span>
      )}

      {searchResults.length > 0 && !searchError && (
        <div className="search-results">
          {searchResults.map((obj) => (
            <div
              key={obj.object_id}
              className="search-result-item"
              onClick={() => {
                const satId = `obj-${obj.object_id}`
                onGo(satId)
                setSearchResults([])
                setQuery('')
              }}
            >
              <span className="search-result-name">{obj.name}</span>
            </div>
          ))}
        </div>
      )}

      {notFound && <span className="search-not-found">No match</span>}
    </form>
  )
}

function SatelliteInfoCard({
  selectedId,
  onClear,
  satellites,
  details,
  media,
  loading,
  error,
  onRetry,
  selectedSatelliteState
}: {
  selectedId: string | null;
  onClear: () => void;
  satellites: SatelliteDef[];
  details: ObjectDetails | null;
  media: MediaResponse | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  selectedSatelliteState?: StateResponse | null;
}) {
  if (!selectedId) return null
  const sat = satellites.find((s) => s.id === selectedId)
  if (!sat) return null
  const category = CATEGORIES.find((c) => c.id === sat.categoryId)

  // Use real backend data if available, fallback to local satellite data
  const name = details?.name ?? sat.name
  const categoryName = details?.category ?? category?.name ?? 'Satellite'
  const metadata = details?.metadata ?? {}
  const mediaItems = media?.media ?? []

  // Get cached state for immediate display
  const cachedState = selectedSatelliteState

  return (
    <aside className="satellite-info-card satellite-info-fixed" aria-live="polite">
      <div className="info-card-header">
        <span
          className="info-card-dot"
          style={{ background: '#fff', boxShadow: `0 0 10px ${category?.color ?? '#fff'}` }}
        />
        <span className="info-card-name">{name}</span>
        <button className="info-card-close" onClick={onClear} aria-label="Close satellite details">×</button>
      </div>
      {error && (
        <div className="info-card-row error-message">
          {error}
          {onRetry && (
            <button className="retry-button" onClick={onRetry} type="button">
              Retry
            </button>
          )}
        </div>
      )}
      <div className="info-card-row"><span>Category</span><span>{categoryName}</span></div>
      {(metadata.launch_date || metadata.launchDate) && <div className="info-card-row"><span>Launch Date</span><span>{metadata.launch_date ?? metadata.launchDate}</span></div>}
      {(metadata.operator || metadata.operator_name) && <div className="info-card-row"><span>Operator</span><span>{metadata.operator ?? metadata.operator_name}</span></div>}
      {(metadata.mass || metadata.mass_kg) && <div className="info-card-row"><span>Mass</span><span>{metadata.mass ?? metadata.mass_kg} kg</span></div>}
      {mediaItems.length > 0 && (
        <div className="info-card-row">
          <span>Media</span>
          <div style={{ marginTop: '4px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {mediaItems.slice(0, 3).map((item, idx) => (
              <a key={idx} href={item.url} target="_blank" rel="noopener noreferrer" className="info-media-link" style={{ color: '#4fd3ff', textDecoration: 'underline', fontSize: '9px' }}>
                {item.media_type} {item.source_id ? `(src ${item.source_id})` : ''}
              </a>
            ))}
          </div>
        </div>
      )}
      {/* Show cached state immediately, loading indicator only for missing data */}
      {cachedState?.altitude !== null && cachedState?.altitude !== undefined ? (
        <div className="info-card-row"><span>Altitude</span><span>{cachedState.altitude.toFixed(1)} km</span></div>
      ) : loading && (
        <div className="info-card-row"><span>Altitude</span><span className="loading-indicator">Loading…</span></div>
      )}
      {cachedState?.epoch ? (
        <div className="info-card-row"><span>Epoch</span><span>{new Date(cachedState.epoch).toISOString()}</span></div>
      ) : loading && (
        <div className="info-card-row"><span>Epoch</span><span className="loading-indicator">Loading…</span></div>
      )}
      {cachedState?.source && (
        <div className="info-card-row"><span>Source</span><span>{cachedState.source}</span></div>
      )}
      {cachedState?.status && (
        <div className="info-card-row"><span>Status</span><span style={{ textTransform: 'capitalize' }}>{cachedState.status}</span></div>
      )}
      <div className="info-card-focus">SATELLITE + ORBIT HIGHLIGHTED</div>
    </aside>
  )
}

/* ============================================================
   APP
   ============================================================ */

export default function App() {
  const [earthReady, setEarthReady] = useState(false)
  const [starsReady, setStarsReady] = useState(false)

  const [phase, setPhase] = useState<IntroPhase>('intro')

  const [forceReady, setForceReady] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setForceReady(true), 2500)
    return () => window.clearTimeout(t)
  }, [])

  const canEnter = starsReady || earthReady || forceReady

  // Controls enabled state for CameraRig to disable OrbitControls during flight
  const [controlsEnabled, setControlsEnabled] = useState(true)

  // Satellite data from API - initial ~10 rendered in 3D scene
  // This is the ACTIVE RENDER SET - limited to ~15 objects for performance
  const [renderedSatellites, setRenderedSatellites] = useState<SatelliteDef[]>([])
  const [, setSatellitesLoading] = useState(true)
  const [, setSatellitesError] = useState<string | null>(null)

  // MAX_RENDERED_SATELLITES applies ONLY to the on-demand expensive render set
  // (selected satellite highlight, orbit geometry, detail meshes).
  // Category-wide GPU Points rendering is driven by bulk state and is NOT subject to this limit.
  const MAX_RENDERED_SATELLITES = 15

  // Complete Exploration Catalogue - paginated access to all backend objects
  const [catalogue, setCatalogue] = useState<{
    objects: SatelliteDef[];
    totalCount: number;
    loading: boolean;
    error: string | null;
    currentPage: number;
    pageSize: number;
  }>({
    objects: [],
    totalCount: 0,
    loading: true,
    error: null,
    currentPage: 0,
    pageSize: 50,
  })

  // Category-level catalogue state for virtualized loading
  const [categoryPages, setCategoryPages] = useState<Record<number, number>>({})
  const [categoryLoading, setCategoryLoading] = useState<Set<number>>(new Set())
  const [categoryObjects, setCategoryObjects] = useState<Record<number, SatelliteDef[]>>({})
  const [categoryTotalCounts, setCategoryTotalCounts] = useState<Record<number, number>>({})

  // Category bulk position state - tracks loading of real positions for category points
  const [categoryBulkPositions, setCategoryBulkPositions] = useState<Record<number, {
    loadedCount: number
    totalCount: number
    hasMore: boolean
    loading: boolean
    page: number
    objectIds: number[]
  }>>({})

  // In-flight request tracking for deduplication
  const bulkStateRequestsRef = useRef<Map<string, AbortController>>(new Map())

  // Satellite data cache - Map<object_id, SatelliteData>
  // Using useState with lazy initializer - we mutate the Map in-place and don't trigger re-renders
  const [satelliteCache] = useState(() => new Map<number, {
    satellite: SatelliteDef;
    state?: StateResponse;
    details?: ObjectDetails;
    media?: MediaResponse;
  }>())

  // Load satellite data from API - initial small set (~10) with real position data
  useEffect(() => {
    let cancelled = false
    async function loadSatellites() {
      try {
        setSatellitesLoading(true)
        setSatellitesError(null)
        const response = await api.list({ limit: 10 })
        if (!cancelled) {
          const mapped = response.results.map(mapObjectSummaryToSatellite)
          setRenderedSatellites(mapped)
          // Cache initial satellites and fetch their state/position
          for (const sat of mapped) {
            const objectId = sat.objectId
            satelliteCache.set(objectId, { satellite: sat })

            // Fetch real position data for initial satellites
            try {
              const state = await api.state(objectId)
              if (!cancelled) {
                const cached = satelliteCache.get(objectId)
                if (cached) {
                  satelliteCache.set(objectId, { ...cached, state })
                }
              }
            } catch (err) {
              console.warn(`Failed to load state for satellite ${objectId}:`, err)
            }
          }
          // Trigger re-render with updated cache
          setRenderedSatellites([...mapped])
        }
      } catch (err) {
        if (!cancelled) {
          const error = err as Error
          setSatellitesError(error.message || 'Failed to load satellites')
        }
      } finally {
        if (!cancelled) {
          setSatellitesLoading(false)
        }
      }
    }
    loadSatellites()
    return () => { cancelled = true }
  }, [satelliteCache])

  // Load Exploration Catalogue - complete backend catalogue with pagination
  useEffect(() => {
    let cancelled = false
    async function loadCatalogue() {
      try {
        setCatalogue(prev => ({ ...prev, loading: true, error: null }))
        const response = await api.list({ limit: 50, offset: 0 })
        if (!cancelled) {
          const mapped = response.results.map(mapObjectSummaryToSatellite)
          setCatalogue(prev => ({
            ...prev,
            objects: mapped,
            totalCount: response.total_count,
            loading: false,
            currentPage: 0,
          }))
          // Cache catalogue objects
          for (const sat of mapped) {
            satelliteCache.set(sat.objectId, { satellite: sat })
          }

          // Fetch total counts per category for accurate sidebar counts
          // Using backend's category filter to get total_count for each category
          try {
            const categoryCountPromises = CATEGORIES.map(async (cat) => {
              const catResponse = await api.list({
                limit: 1,
                offset: 0,
                category: cat.backendCategoryId
              })
              return { backendCategoryId: cat.backendCategoryId, totalCount: catResponse.total_count }
            })
            const categoryCounts = await Promise.all(categoryCountPromises)
            if (!cancelled) {
              const countsMap: Record<number, number> = {}
              categoryCounts.forEach(({ backendCategoryId, totalCount }) => {
                countsMap[backendCategoryId] = totalCount
              })
              setCategoryTotalCounts(countsMap)
            }
          } catch (err) {
            console.warn('Failed to load category totals:', err)
          }
        }
      } catch (err) {
        if (!cancelled) {
          const error = err as Error
          setCatalogue(prev => ({ ...prev, loading: false, error: error.message || 'Failed to load catalogue' }))
        }
      }
    }
    loadCatalogue()
    return () => { cancelled = true }
  }, [satelliteCache])

  // Satellite / UI state
  const [activeCategories, setActiveCategories] = useState<Set<string>>(
    () => new Set(CATEGORIES.map((c) => c.id)),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const positionsRef = useRef<Map<string, THREE.Vector3>>(new Map())

  // Real orbital state for selected satellite (from /api/v1/objects/{id}/state)
  const [selectedSatelliteState, setSelectedSatelliteState] = useState<StateResponse | null>(null)

  // Real satellite details and media (from /api/v1/objects/{id} and /api/v1/objects/{id}/media)
  const [selectedSatelliteDetails, setSelectedSatelliteDetails] = useState<ObjectDetails | null>(null)
  const [selectedSatelliteMedia, setSelectedSatelliteMedia] = useState<MediaResponse | null>(null)

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)

  // Selection generation counter for race condition protection
  const selectionGenRef = useRef(0)

  // Satellite details loading/error state
  const [satelliteDetailsLoading, setSatelliteDetailsLoading] = useState(false)
  const [satelliteDetailsError, setSatelliteDetailsError] = useState<string | null>(null)

  const toggleCategory = (id: string) => {
    setActiveCategories((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        // Stop bulk loading when category is disabled
        const cat = CATEGORIES.find(c => c.id === id)
        if (cat) stopCategoryBulkLoading(cat.backendCategoryId)
      } else {
        next.add(id)
        // Start bulk loading when category is enabled
        const cat = CATEGORIES.find(c => c.id === id)
        if (cat) startCategoryBulkLoading(cat.backendCategoryId)
      }
      return next
    })
  }

  // On-demand satellite loading with caching - fetches real position data

  // Load catalogue objects by category with pagination
  const loadCatalogueByCategory = async (backendCategoryId: number, page: number) => {
    try {
      const offset = page * catalogue.pageSize
      const response = await api.list({
        limit: catalogue.pageSize,
        offset,
        category: backendCategoryId,
      })
      const mapped = response.results.map(mapObjectSummaryToSatellite)

      setCategoryObjects(prev => {
        const existing = prev[backendCategoryId] || []
        const existingIds = new Set(existing.map(s => s.id))
        const newObjects = mapped.filter(s => !existingIds.has(s.id))
        return {
          ...prev,
          [backendCategoryId]: [...existing, ...newObjects],
        }
      })

      setCategoryTotalCounts(prev => ({
        ...prev,
        [backendCategoryId]: response.total_count,
      }))

      // Cache new objects
      for (const sat of mapped) {
        satelliteCache.set(sat.objectId, { satellite: sat })
      }
    } catch (err) {
      console.error('Failed to load catalogue by category:', err)
    }
  }

  // Progressive bulk state loading for a category
  const loadBulkPositionsForCategory = async (backendCategoryId: number) => {
    const currentBulk = categoryBulkPositions[backendCategoryId]
    const currentPage = currentBulk?.page ?? 0
    const hasMore = currentBulk?.hasMore ?? true
    const isLoading = currentBulk?.loading ?? false

    if (!hasMore || isLoading) return

    // Check if already fetching this page
    const requestKey = `bulk-${backendCategoryId}-${currentPage}`
    if (bulkStateRequestsRef.current.has(requestKey)) return

    const controller = new AbortController()
    bulkStateRequestsRef.current.set(requestKey, controller)

    try {
      setCategoryBulkPositions(prev => ({
        ...prev,
        [backendCategoryId]: {
          ...(prev[backendCategoryId] || { loadedCount: 0, totalCount: 0, hasMore: true, loading: false, page: currentPage, objectIds: [] }),
          loading: true,
        }
      }))

      const response = await api.bulkState({
        category: backendCategoryId,
        limit: 250,
        offset: currentPage * 250,
      })

      if (controller.signal.aborted) return

      // Update satellite cache with position data
      // Create lightweight SatelliteDefs directly from bulk state results
      // using known category info - no individual api.list calls
      const frontendCategoryId = BACKEND_TO_FRONTEND_CATEGORY[backendCategoryId] ?? 'scientific'

      for (const state of response.results) {
        const objectId = state.object_id
        const cached = satelliteCache.get(objectId)

        // Create lightweight SatelliteDef if not in cache
        if (!cached) {
          const satellite: SatelliteDef = {
            id: `obj-${objectId}`,
            name: `Object ${objectId}`, // Temporary name, will be replaced when details fetched
            categoryId: frontendCategoryId,
            backendCategoryId,
            noradId: 0, // Will be updated when real data fetched
            objectId,
          }
          satelliteCache.set(objectId, { satellite, state })
        } else {
          // Update existing cache with real state
          satelliteCache.set(objectId, { ...cached, state })
        }
      }

      const objectIds = response.results.map(r => r.object_id)

      setCategoryBulkPositions(prev => ({
        ...prev,
        [backendCategoryId]: {
          loadedCount: (prev[backendCategoryId]?.loadedCount || 0) + response.count,
          totalCount: response.total_count,
          hasMore: response.has_more,
          loading: false,
          page: currentPage + 1,
          objectIds: [...(prev[backendCategoryId]?.objectIds || []), ...objectIds],
        }
      }))

      // Trigger re-render to show new points
      setRenderedSatellites(prev => [...prev])

      // Auto-load next page if more available (progressive loading)
      if (response.has_more) {
        // Small delay to prevent blocking main thread
        setTimeout(() => {
          loadBulkPositionsForCategory(backendCategoryId)
        }, 50)
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      console.error('Failed to load bulk positions for category:', err)
      setCategoryBulkPositions(prev => ({
        ...prev,
        [backendCategoryId]: {
          ...(prev[backendCategoryId] || { loadedCount: 0, totalCount: 0, hasMore: false, loading: false, page: currentPage, objectIds: [] }),
          loading: false,
        }
      }))
    } finally {
      bulkStateRequestsRef.current.delete(requestKey)
    }
  }

  // Load initial bulk positions when category is enabled
  const startCategoryBulkLoading = (backendCategoryId: number) => {
    const bulk = categoryBulkPositions[backendCategoryId]
    if (!bulk || bulk.loadedCount === 0) {
      loadBulkPositionsForCategory(backendCategoryId)
    }
  }

  // Stop bulk loading for a category (when disabled)
  const stopCategoryBulkLoading = (backendCategoryId: number) => {
    const requestKey = `bulk-${backendCategoryId}-${categoryBulkPositions[backendCategoryId]?.page ?? 0}`
    const controller = bulkStateRequestsRef.current.get(requestKey)
    if (controller) {
      controller.abort()
      bulkStateRequestsRef.current.delete(requestKey)
    }
  }

  // Start bulk loading for initially active categories
  useEffect(() => {
    activeCategories.forEach((catId) => {
      const cat = CATEGORIES.find(c => c.id === catId)
      if (cat) {
        startCategoryBulkLoading(cat.backendCategoryId)
      }
    })
  }, [activeCategories]) // eslint-disable-line react-hooks/exhaustive-deps

  // On-demand satellite loading with caching - fetches real position data
  // Adds to active render set with limit to prevent unbounded growth (for expensive representations only)
  // Category-wide GPU Points rendering is driven by bulk state and is NOT subject to this limit
  const loadSatelliteOnDemand = async (objectId: number, isSelected: boolean = false): Promise<SatelliteDef | null> => {
    // Check cache first
    const cached = satelliteCache.get(objectId)
    if (cached) {
      // Ensure cached satellite is in render set
      setRenderedSatellites(prev => {
        if (prev.some(s => s.id === cached.satellite.id)) return prev
        // Add to render set, enforcing max limit for non-selected
        const next = [...prev, cached.satellite]
        if (!isSelected && next.length > MAX_RENDERED_SATELLITES) {
          // Remove oldest non-selected satellite
          return next.slice(-MAX_RENDERED_SATELLITES)
        }
        return next
      })
      return cached.satellite
    }

    try {
      // Fetch from API
      const response = await api.get(objectId)
      const summary: ObjectSummary = {
        object_id: response.object_id,
        name: response.name,
        norad_id: response.norad_id ?? 0,
        category_id: response.category_id ?? 1,
      }
      const satellite = mapObjectSummaryToSatellite(summary)

      // Cache it
      satelliteCache.set(objectId, { satellite })

      // Add to render set with max limit (skip limit for selected)
      setRenderedSatellites(prev => {
        if (prev.some(s => s.id === satellite.id)) return prev
        const next = [...prev, satellite]
        if (!isSelected && next.length > MAX_RENDERED_SATELLITES) {
          return next.slice(-MAX_RENDERED_SATELLITES)
        }
        return next
      })

      // Fetch real position data
      try {
        const state = await api.state(objectId)
        const cached = satelliteCache.get(objectId)
        if (cached) {
          satelliteCache.set(objectId, { ...cached, state })
        }
        // Trigger re-render to show satellite at real position
        setRenderedSatellites(prev => [...prev])
      } catch (err) {
        console.warn(`Failed to load state for satellite ${objectId}:`, err)
      }

      return satellite
    } catch (err) {
      console.error('Failed to load satellite on demand:', err)
      return null
    }
  }

  const fetchSatelliteData = async (objectId: number) => {
    // Increment generation to invalidate stale responses
    const currentGen = ++selectionGenRef.current

    // First, show cached data immediately if available
    const cached = satelliteCache.get(objectId)
    if (cached) {
      if (cached.state) setSelectedSatelliteState(cached.state)
      if (cached.details) setSelectedSatelliteDetails(cached.details)
      if (cached.media) setSelectedSatelliteMedia(cached.media)
    }

    setSatelliteDetailsLoading(true)
    setSatelliteDetailsError(null)
    // Don't clear cached state - keep it visible while fetching fresh data

    try {
      const [state, details, media] = await Promise.all([
        api.state(objectId),
        api.get(objectId),
        api.media(objectId),
      ])

      // Race condition check: only apply if still the current selection
      if (currentGen !== selectionGenRef.current) {
        return // Stale response, discard
      }

      setSelectedSatelliteState(state)
      setSelectedSatelliteDetails(details)
      setSelectedSatelliteMedia(media)

      // Update cache with state/details/media
      const cached = satelliteCache.get(objectId)
      if (cached) {
        satelliteCache.set(objectId, {
          ...cached,
          state,
          details,
          media,
        })
      }
    } catch (err) {
      if (currentGen !== selectionGenRef.current) {
        return // Stale response, discard
      }
      const message = err instanceof Error ? err.message : 'Failed to load satellite data'
      setSatelliteDetailsError(message)
      // Don't clear state on error - keep cached data visible
    } finally {
      if (currentGen === selectionGenRef.current) {
        setSatelliteDetailsLoading(false)
      }
    }
  }

  const goToSatellite = (id: string) => {
    // Parse object_id from obj-{object_id}
    const objectId = parseInt(id.replace('obj-', ''), 10)
    if (isNaN(objectId)) return

    // Check render set first, then cache, then category objects
    let sat = renderedSatellites.find((s) => s.id === id)
    if (!sat) {
      const cached = satelliteCache.get(objectId)
      if (cached) sat = cached.satellite
    }
    if (!sat) {
      // Check category objects
      activeCategories.forEach((catId) => {
        const backendCatId = CATEGORIES.find(c => c.id === catId)?.backendCategoryId
        if (!backendCatId) return
        const catObjects = categoryObjects[backendCatId] || []
        const found = catObjects.find((s) => s.id === id)
        if (found) sat = found
      })
    }

    // If still missing, load on-demand
    if (!sat) {
      loadSatelliteOnDemand(objectId, true).then((loadedSat) => {
        if (loadedSat) {
          setSelectedId(loadedSat.id)
          fetchSatelliteData(objectId)
        }
      })
      return
    }

    // sat is guaranteed to exist here (early return above)
    const satDef = sat!
    if (!activeCategories.has(satDef.categoryId)) {
      setActiveCategories((prev) => new Set(prev).add(satDef.categoryId))
    }

    // Use canonical obj-{object_id} format
    const canonicalId = `obj-${objectId}`
    setSelectedId(canonicalId)

    // Fetch real orbital state for this satellite
    if (objectId) {
      loadSatelliteOnDemand(objectId, true).then(() => {
        fetchSatelliteData(objectId)
      })
    }
    // Selection is intentionally non-zooming: keep the Earth framing stable.
    setSidebarOpen(false)
  }

  const clearSelection = () => {
    setSelectedId(null)
    setSelectedSatelliteState(null)
    setSelectedSatelliteDetails(null)
    setSelectedSatelliteMedia(null)
  }

  const executeAICommand = (cmdResult: AICommandResult) => {
    const { command, result } = cmdResult
    const objectId = result?.data?.object?.object_id ?? result?.data?.object_id
    const satId = objectId ? String(objectId) : null

    const paginatedData = result?.data as { results?: Array<{ object_id: number }> } | undefined
    const firstResult = paginatedData?.results?.[0]
    const firstResultId = firstResult ? `obj-${firstResult.object_id}` : null

    switch (command) {
      case 'focus_object':
      case 'follow_object':
      case 'show_orbit':
      case 'open_information_panel':
        if (satId) {
          goToSatellite(satId)
        }
        break
      case 'find_object':
        if (firstResultId) {
          goToSatellite(firstResultId)
        }
        break
      case 'filter_objects': {
        if (firstResultId) {
          goToSatellite(firstResultId)
        }
        const filterCategory = result?.data?.category as number | undefined
        if (filterCategory !== undefined) {
          const frontendCat = BACKEND_TO_FRONTEND_CATEGORY[filterCategory]
          if (frontendCat) {
            setActiveCategories((prev) => {
              const next = new Set(prev)
              next.clear()
              next.add(frontendCat)
              return next
            })
          }
        }
        break
      }
      default:
        break
    }
  }

  const handleEnter = () => {
    if (phase !== 'intro' || !canEnter) return
    setPhase('main')
  }

  const handleEarthReady = useCallback(() => {
    setEarthReady(true)
  }, [])

  const handleStarsReady = useCallback(() => {
    setStarsReady(true)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        handleEnter()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <main className={`earth-experience ${phase === 'main' ? 'is-main' : ''}`}>
      <div className="earth-canvas-wrap">
        <Canvas
          camera={{
            position: [0, 0, 10.5],
            fov: 40,
            near: 0.1,
            far: 250,
          }}
          dpr={[1, 1.75]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          onPointerMissed={() => {
            if (phase === 'main') clearSelection()
          }}
        >
<Scene
            phase={phase}
            onEarthReady={handleEarthReady}
            onStarsReady={handleStarsReady}
            activeCategories={activeCategories}
            selectedId={selectedId}
            onSelectSatellite={goToSatellite}
            positionsRef={positionsRef}
            satellites={renderedSatellites}
            selectedSatelliteState={selectedSatelliteState}
            satelliteCache={satelliteCache}
            categoryObjects={categoryObjects}
            categoryBulkPositions={categoryBulkPositions}
            controlsEnabled={controlsEnabled}
            setControlsEnabled={setControlsEnabled}
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

          <button className="mobile-exploration-bar" onClick={() => setSidebarOpen(true)}>
            <span>EXPLORATION</span>
            <span className="mobile-exploration-chevron">⌄</span>
          </button>

          <ExplorationSidebar
            activeCategories={activeCategories}
            toggleCategory={toggleCategory}
            mobileOpen={sidebarOpen}
            setMobileOpen={setSidebarOpen}
            selectedId={selectedId}
            onSelectSatellite={goToSatellite}
            onClearSelection={clearSelection}
            satellites={renderedSatellites}
            catalogue={catalogue}
            categoryPages={categoryPages}
            setCategoryPages={setCategoryPages}
            categoryLoading={categoryLoading}
            setCategoryLoading={setCategoryLoading}
            categoryObjects={categoryObjects}
            categoryTotalCounts={categoryTotalCounts}
            loadCatalogueByCategory={loadCatalogueByCategory}
          />

          <AIPanel mobileOpen={aiOpen} setMobileOpen={setAiOpen} satelliteInfoOpen={Boolean(selectedId)} onExecuteCommand={executeAICommand} />
          <SatelliteInfoCard
            selectedId={selectedId}
            onClear={clearSelection}
            satellites={renderedSatellites}
            details={selectedSatelliteDetails}
            media={selectedSatelliteMedia}
            loading={satelliteDetailsLoading}
            error={satelliteDetailsError}
            onRetry={selectedId ? () => fetchSatelliteData(parseInt(selectedId.replace('obj-', ''), 10)) : undefined}
            selectedSatelliteState={selectedSatelliteState}
          />
          <div className="earth-controls-hint">
            DRAG TO ROTATE&nbsp;&nbsp;·&nbsp;&nbsp;SCROLL TO ZOOM
          </div>
        </>
      )}
    </main>
  )
}
