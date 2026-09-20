import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, MutableRefObject } from 'react'
import * as THREE from 'three'
import { api, type ObjectSummary } from './lib/types'

const EARTH_RADIUS = 2.2

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
  orbitRadiusFactor: number
  inclinationDeg: number
  phaseDeg: number
  speed: number
  noradId: number
}

// Map backend category_id (1-7) to frontend category IDs
const BACKEND_TO_FRONTEND_CATEGORY: Record<number, string> = {
  1: 'sci', // Space Stations
  2: 'nav', // Navigation
  3: 'comm', // Communication
  4: 'wx', // Weather
  5: 'sci', // Scientific
  6: 'comm', // Rocket Bodies -> Communication
  7: 'eo', // Space Debris -> Earth Observation
}

// Frontend category definitions (preserving existing UI colors/labels)
const CATEGORIES: Category[] = [
  { id: 'comm', name: 'Communication', color: '#4fd3ff', backendCategoryId: 3 },
  { id: 'nav', name: 'Navigation', color: '#ffcf4f', backendCategoryId: 2 },
  { id: 'eo', name: 'Earth Observation', color: '#6fff9f', backendCategoryId: 7 },
  { id: 'wx', name: 'Weather', color: '#ff6f91', backendCategoryId: 4 },
  { id: 'sci', name: 'Scientific', color: '#b58bff', backendCategoryId: 1 },
]

type AICommandResult = {
  command: string
  result?: {
    data?: {
      object?: { object_id: number }
      object_id?: number
      results?: Array<{ object_id: number }>
      category?: number
      count?: number
      total_count?: number
      limit?: number
      offset?: number
      has_more?: boolean
    }
  }
}

function categoryColor(categoryId: string): string {
  return CATEGORIES.find((c) => c.id === categoryId)?.color ?? '#ffffff'
}

function mapObjectSummaryToSatellite(obj: ObjectSummary): SatelliteDef {
  const frontendCategoryId = BACKEND_TO_FRONTEND_CATEGORY[obj.category_id] ?? 'sci'
  // Generate deterministic but varied orbital parameters based on NORAD ID
  const norad = obj.norad_id
  const orbitRadiusFactor = 1.2 + ((norad * 7) % 100) / 100 * 1.5 // 1.2 - 2.7
  const inclinationDeg = (norad * 13) % 180 // 0 - 179
  const phaseDeg = (norad * 17) % 360 // 0 - 359
  const speed = 0.05 + ((norad * 11) % 100) / 100 * 0.25 // 0.05 - 0.30

  return {
    id: `obj-${obj.object_id}`,
    name: obj.name,
    categoryId: frontendCategoryId,
    backendCategoryId: obj.category_id,
    orbitRadiusFactor,
    inclinationDeg,
    phaseDeg,
    speed,
    noradId: obj.norad_id,
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
  }, [gl])

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
  }, [])

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
   SATELLITE ORBIT + DOT
   ============================================================ */

function satellitePosition(sat: SatelliteDef): THREE.Vector3 {
  const angle = (sat.phaseDeg * Math.PI) / 180
  const inclination = (sat.inclinationDeg * Math.PI) / 180
  const radius = EARTH_RADIUS * sat.orbitRadiusFactor
  const v = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
  v.applyAxisAngle(new THREE.Vector3(1, 0, 0), inclination)
  return v
}

function SelectedOrbit({ sat }: { sat: SatelliteDef }) {
  const positionAttribute = useMemo(() => {
    const segments = 192
    const radius = EARTH_RADIUS * sat.orbitRadiusFactor
    const inclination = (sat.inclinationDeg * Math.PI) / 180
    const positions = new Float32Array((segments + 1) * 3)
    const axis = new THREE.Vector3(1, 0, 0)

    for (let i = 0; i <= segments; i += 1) {
      const a = (i / segments) * Math.PI * 2
      const v = new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius)
      v.applyAxisAngle(axis, inclination)
      positions[i * 3] = v.x
      positions[i * 3 + 1] = v.y
      positions[i * 3 + 2] = v.z
    }

    return new THREE.BufferAttribute(positions, 3)
  }, [sat])

  const color = categoryColor(sat.categoryId)

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
}: {
  activeCategories: Set<string>
  selectedId: string | null
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
  positionsRef: MutableRefObject<Map<string, THREE.Vector3>>
  satellites: SatelliteDef[]
}) {
  const pointsRef = useRef<THREE.Points>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null)
  const draggedRef = useRef(false)
  const particleTexture = useMemo(() => createSatelliteParticleTexture(), [])

  const { positions, colors, positionsById } = useMemo(() => {
    const positions = new Float32Array(satellites.length * 3)
    const colors = new Float32Array(satellites.length * 3)
    const positionsById = new Map<string, THREE.Vector3>()

    satellites.forEach((sat, index) => {
      const pos = satellitePosition(sat)
      positions[index * 3] = pos.x
      positions[index * 3 + 1] = pos.y
      positions[index * 3 + 2] = pos.z
      positionsById.set(sat.id, pos)

      const c = new THREE.Color(categoryColor(sat.categoryId))
      colors[index * 3] = c.r
      colors[index * 3 + 1] = c.g
      colors[index * 3 + 2] = c.b
    })

    return { positions, colors, positionsById }
  }, [satellites])

  useEffect(() => {
    positionsRef.current.clear()
    satellites.forEach((sat) => {
      if (activeCategories.has(sat.categoryId)) {
        const pos = positionsById.get(sat.id)
        if (pos) positionsRef.current.set(sat.id, pos)
      }
    })
  }, [activeCategories, positionsById, positionsRef, satellites])

  useEffect(() => {
    if (!pointsRef.current) return
    const attribute = pointsRef.current.geometry.getAttribute('color') as THREE.BufferAttribute
    const array = attribute.array as Float32Array

    satellites.forEach((sat, index) => {
      const selected = sat.id === selectedId
      const hovered = index === hoveredIndex
      const active = activeCategories.has(sat.categoryId)
      const base = new THREE.Color(selected || hovered ? '#ffffff' : categoryColor(sat.categoryId))
      const multiplier = active ? (selected ? 3.0 : hovered ? 2.1 : 1.72) : 0.02
      array[index * 3] = base.r * multiplier
      array[index * 3 + 1] = base.g * multiplier
      array[index * 3 + 2] = base.b * multiplier
    })
    attribute.needsUpdate = true
  }, [activeCategories, hoveredIndex, selectedId, satellites])

  useEffect(() => {
    if (pointsRef.current) {
      const material = pointsRef.current.material as THREE.PointsMaterial
      material.size = window.innerWidth <= 820 ? 0.195 : 0.17
    }
  }, [])

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

  const handlePointerMoveOnPoint = (event: any) => {
    if (draggedRef.current || event.buttons) {
      if (hoveredIndex !== null) setHoveredIndex(null)
      onHover(null)
      document.body.style.cursor = 'grabbing'
      return
    }

    const index = typeof event.index === 'number' ? event.index : null
    if (index === hoveredIndex) return
    setHoveredIndex(index)
    onHover(index === null ? null : satellites[index]?.id ?? null)
  }

  const handlePointerOut = () => {
    if (draggedRef.current) return
    setHoveredIndex(null)
    onHover(null)
    document.body.style.cursor = 'auto'
  }

  const handleClick = (event: any) => {
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
    if (index >= 0 && satellites[index]) onSelect(satellites[index].id)
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
        const selectedPosition = positionsById.get(selectedSat.id)
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
            <SelectedOrbit sat={selectedSat} />
          </>
        )
      })()}
    </>
  )
}

/* ============================================================
   CAMERA RIG — handles "fly to satellite" + live tracking
   ============================================================ */

function CameraRig({ phase, selectedId, satellites }: { phase: IntroPhase; selectedId: string | null; satellites: SatelliteDef[] }) {
  const { controls, camera } = useThree((s) => ({ controls: s.controls, camera: s.camera })) as unknown as {
    controls: { target: THREE.Vector3; update: () => void; enabled?: boolean } | null
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

      const satPosition = satellitePosition(sat)
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
      if ('enabled' in controls) controls.enabled = false
    } else {
      destination.set(10.5, current.phi, current.theta)
      flightRef.current = {
        active: true,
        elapsed: 0,
        duration: 0.95,
        fromSpherical: current,
        toSpherical: destination,
      }
      if ('enabled' in controls) controls.enabled = false
    }
  }, [phase, selectedId, controls, camera, satellites])

  useFrame((_, delta) => {
    if (phase !== 'main' || !controls) return

    controls.target.set(0, 0, 0)
    const flight = flightRef.current
    if (!flight?.active) {
      if ('enabled' in controls) controls.enabled = true
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
      if ('enabled' in controls) controls.enabled = true
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
}: {
  phase: IntroPhase
  onEarthReady?: () => void
  onStarsReady?: () => void
  activeCategories: Set<string>
  selectedId: string | null
  onSelectSatellite: (id: string) => void
  positionsRef: MutableRefObject<Map<string, THREE.Vector3>>
  satellites: SatelliteDef[]
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
        />
      )}

      <OrbitControls
        makeDefault
        enabled={phase === 'main'}
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

      <CameraRig phase={phase} selectedId={selectedId} satellites={satellites} />
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
   EXPLORATION SIDEBAR (left) — dummy category/satellite data
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
  satellitesLoading,
  satellitesError,
}: {
  activeCategories: Set<string>
  toggleCategory: (id: string) => void
  mobileOpen: boolean
  setMobileOpen: (v: boolean) => void
  selectedId: string | null
  onSelectSatellite: (id: string) => void
  onClearSelection: () => void
  satellites: SatelliteDef[]
  satellitesLoading: boolean
  satellitesError: string | null
}) {
  return (
    <div className={`side-panel sidebar-panel ${mobileOpen ? 'is-open' : ''}`}>
      <div className="panel-header">
        <span>EXPLORATION</span>
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

      {satellitesLoading && <div className="loading-indicator">Loading satellites…</div>}
      {satellitesError && <div className="error-message">{satellitesError}</div>}

      <div className="panel-scroll">
        {CATEGORIES.map((cat) => {
          const sats = satellites.filter((s) => s.categoryId === cat.id)
          const active = activeCategories.has(cat.id)

          return (
            <div key={cat.id} className="category-group">
              <label className="category-row">
                <input type="checkbox" checked={active} onChange={() => toggleCategory(cat.id)} />
                <span className="cat-dot" style={{ background: cat.color, boxShadow: `0 0 6px ${cat.color}` }} />
                <span className="cat-name">{cat.name}</span>
                <span className="cat-count">{sats.length}</span>
              </label>

              {active && (
                <div className="satellite-sublist">
                  {sats.slice(0, 40).map((sat) => (
                    <button
                      key={sat.id}
                      className={`satellite-item ${selectedId === sat.id ? 'is-selected' : ''}`}
                      onClick={() => onSelectSatellite(sat.id)}
                    >
                      <span className="sat-dot" style={{ background: cat.color }} />
                      {sat.name}
                    </button>
                  ))}
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
      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api/v1'}/ai/explore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: text }),
      })
      const data = await res.json()
      if (data.success) {
        const cmd = data.command ? `✓ Executed: ${data.command}` : '✓ Done'
        const detail = data.result ? ` — ${JSON.stringify(data.result).slice(0, 200)}` : ''
        setMessages((m) => [...m, { role: 'assistant', text: `${cmd}${detail}` }])
        if (data.command) {
          onExecuteCommand({ command: data.command, result: data.result })
        }
      } else {
        const err = data.error || 'Unknown error'
        setMessages((m) => [...m, { role: 'assistant', text: `✗ ${err}` }])
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
   SEARCH BAR — manual "go to satellite" by name
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
  const [notFound, setNotFound] = useState(false)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const q = query.trim().toLowerCase()
    if (!q) return

    const match = satellites.find((s) => s.name.toLowerCase().includes(q))
    if (match) {
      setNotFound(false)
      onGo(match.id)
    } else {
      setNotFound(true)
    }
  }

  const selectedSat = selectedId ? satellites.find((s) => s.id === selectedId) : null

  return (
    <form className="satellite-search" onSubmit={submit}>
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setNotFound(false)
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
      <button type="submit" aria-label="Search satellite">ENTER</button>

      {selectedSat && (
        <button
          type="button"
          className="clear-btn"
          onClick={() => {
            onClear()
            setQuery('')
          }}
        >
          ✕ {selectedSat.name}
        </button>
      )}

      {notFound && <span className="search-not-found">No match</span>}
    </form>
  )
}

function SatelliteInfoCard({ selectedId, onClear, satellites }: { selectedId: string | null; onClear: () => void; satellites: SatelliteDef[] }) {
  if (!selectedId) return null
  const sat = satellites.find((s) => s.id === selectedId)
  if (!sat) return null
  const category = CATEGORIES.find((c) => c.id === sat.categoryId)

  return (
    <aside className="satellite-info-card satellite-info-fixed" aria-live="polite">
      <div className="info-card-header">
        <span
          className="info-card-dot"
          style={{ background: '#fff', boxShadow: `0 0 10px ${category?.color ?? '#fff'}` }}
        />
        <span className="info-card-name">{sat.name}</span>
        <button className="info-card-close" onClick={onClear} aria-label="Close satellite details">×</button>
      </div>
      <div className="info-card-row"><span>Category</span><span>{category?.name ?? 'Satellite'}</span></div>
      <div className="info-card-row"><span>Orbit</span><span>{(sat.orbitRadiusFactor * EARTH_RADIUS).toFixed(2)}× Rₑ</span></div>
      <div className="info-card-row"><span>Inclination</span><span>{sat.inclinationDeg}°</span></div>
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

  // Satellite data from API
  const [satellites, setSatellites] = useState<SatelliteDef[]>([])
  const [satellitesLoading, setSatellitesLoading] = useState(true)
  const [satellitesError, setSatellitesError] = useState<string | null>(null)

  // Load satellite data from API
  useEffect(() => {
    let cancelled = false
    async function loadSatellites() {
      try {
        setSatellitesLoading(true)
        setSatellitesError(null)
        const response = await api.list({ limit: 100 })
        if (!cancelled) {
          const mapped = response.results.map(mapObjectSummaryToSatellite)
          setSatellites(mapped)
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
  }, [])

  // Satellite / UI state
  const [activeCategories, setActiveCategories] = useState<Set<string>>(
    () => new Set(CATEGORIES.map((c) => c.id)),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const positionsRef = useRef<Map<string, THREE.Vector3>>(new Map())

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)

  const toggleCategory = (id: string) => {
    setActiveCategories((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const goToSatellite = (id: string) => {
    const sat = satellites.find((s) => s.id === id)
    if (sat && !activeCategories.has(sat.categoryId)) {
      setActiveCategories((prev) => new Set(prev).add(sat.categoryId))
    }
    setSelectedId(id)
    // Selection is intentionally non-zooming: keep the Earth framing stable.
    setSidebarOpen(false)
  }

  const clearSelection = () => {
    setSelectedId(null)
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
      case 'filter_objects':
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
      default:
        break
    }
  }

  const handleEnter = () => {
    if (phase !== 'intro' || !canEnter) return
    setPhase('main')
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        handleEnter()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

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
            onEarthReady={() => setEarthReady(true)}
            onStarsReady={() => setStarsReady(true)}
            activeCategories={activeCategories}
            selectedId={selectedId}
            onSelectSatellite={goToSatellite}
            positionsRef={positionsRef}
            satellites={satellites}
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
            satellites={satellites}
            satellitesLoading={satellitesLoading}
            satellitesError={satellitesError}
          />

          <AIPanel mobileOpen={aiOpen} setMobileOpen={setAiOpen} satelliteInfoOpen={Boolean(selectedId)} onExecuteCommand={executeAICommand} />
          <SatelliteInfoCard selectedId={selectedId} onClear={clearSelection} satellites={satellites} />
          <div className="earth-controls-hint">
            DRAG TO ROTATE&nbsp;&nbsp;·&nbsp;&nbsp;SCROLL TO ZOOM
          </div>
        </>
      )}
    </main>
  )
}