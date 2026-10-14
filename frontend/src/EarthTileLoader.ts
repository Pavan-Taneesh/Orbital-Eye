import * as THREE from 'three'

// ============================================================
// Configuration
// ============================================================

const TILE_SIZE = 1024

// Level definitions — each level doubles in resolution
const LEVELS = [
  { level: 0, width: 2048,  height: 1024, cols: 2,  rows: 1 },
  { level: 1, width: 4096,  height: 2048, cols: 4,  rows: 2 },
  { level: 2, width: 8192,  height: 4096, cols: 8,  rows: 4 },
  { level: 3, width: 16384, height: 8192, cols: 16, rows: 8 },
] as const

type LevelConfig = (typeof LEVELS)[number]


// ============================================================
// Image Loader
// ============================================================

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Failed to load Earth tile: ${src}`))
    image.src = src
  })
}


// ============================================================
// Level Texture Assembler
// ============================================================

async function assembleLevel(config: LevelConfig): Promise<THREE.CanvasTexture> {
  const { level, width, height, cols, rows } = config

  console.log(`🌍 Loading Earth level ${level} (${width}×${height})...`)
  const startTime = performance.now()

  // Create canvas at level resolution
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create canvas context')

  // Load all tiles for this level in parallel
  const tiles = await Promise.all(
    Array.from({ length: rows }, (_, row) =>
      Promise.all(
        Array.from({ length: cols }, (_, col) =>
          loadImage(`/earth-tiles/${level}/${row}/${col}.jpg`)
        )
      )
    )
  )

  // Assemble tiles onto canvas
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      ctx.drawImage(
        tiles[row][col],
        col * TILE_SIZE,
        row * TILE_SIZE,
        TILE_SIZE,
        TILE_SIZE,
      )
    }
  }

  // Create Three.js texture
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 16
  texture.generateMipmaps = true
  texture.needsUpdate = true

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
  console.log(`🌍 Level ${level} ready (${elapsed}s)`)

  return texture
}


// ============================================================
// LOD Earth Texture Manager
// ============================================================

export class EarthLOD {
  private textures: Map<number, THREE.CanvasTexture> = new Map()
  private loading: Set<number> = new Set()
  private currentLevel = -1
  private onTextureChange: ((texture: THREE.CanvasTexture, level: number) => void) | null = null

  // Camera distance thresholds for each level
  private static readonly THRESHOLDS = [
    { level: 0, maxDistance: Infinity }, // Always loaded first
    { level: 1, maxDistance: 8.0 },     // Medium zoom
    { level: 2, maxDistance: 5.0 },     // Close zoom
    { level: 3, maxDistance: 3.2 },     // Very close zoom
  ]

  /**
   * Set the callback for when a higher-res texture becomes available
   */
  onChange(callback: (texture: THREE.CanvasTexture, level: number) => void): void {
    this.onTextureChange = callback
  }

  /**
   * Initialize by loading Level 0 immediately
   */
  async init(): Promise<THREE.CanvasTexture> {
    const texture = await assembleLevel(LEVELS[0])
    this.textures.set(0, texture)
    this.currentLevel = 0
    return texture
  }

  /**
   * Call each frame with camera distance to trigger LOD upgrades
   */
  update(cameraDistance: number): void {
    // Find the highest level we should be at for this distance
    let targetLevel = 0
    for (const { level, maxDistance } of EarthLOD.THRESHOLDS) {
      if (cameraDistance <= maxDistance) {
        targetLevel = level
      }
    }

    // If we need a higher level and haven't loaded or started loading it
    if (targetLevel > this.currentLevel && !this.loading.has(targetLevel)) {
      // Load all intermediate levels we might have skipped
      for (let lvl = this.currentLevel + 1; lvl <= targetLevel; lvl++) {
        if (!this.textures.has(lvl) && !this.loading.has(lvl)) {
          this.loadLevel(lvl)
        }
      }
    }
  }

  private async loadLevel(level: number): Promise<void> {
    if (this.loading.has(level) || this.textures.has(level)) return

    this.loading.add(level)

    try {
      const texture = await assembleLevel(LEVELS[level])
      this.textures.set(level, texture)
      this.loading.delete(level)

      // Only upgrade if this is actually a higher level than current
      if (level > this.currentLevel) {
        this.currentLevel = level

        // Dispose old lower-level textures to free GPU memory
        // Keep current and one level below for smooth transitions
        for (const [oldLevel, oldTexture] of this.textures) {
          if (oldLevel < level - 1) {
            oldTexture.dispose()
            this.textures.delete(oldLevel)
            console.log(`🌍 Disposed level ${oldLevel} texture`)
          }
        }

        this.onTextureChange?.(texture, level)
      }
    } catch (error) {
      this.loading.delete(level)
      console.error(`🌍 Failed to load level ${level}:`, error)
    }
  }

  /**
   * Get current texture level
   */
  getLevel(): number {
    return this.currentLevel
  }

  /**
   * Clean up all textures
   */
  dispose(): void {
    for (const [, texture] of this.textures) {
      texture.dispose()
    }
    this.textures.clear()
    this.loading.clear()
  }
}


// ============================================================
// Simple single-level loader (backward compatible)
// ============================================================

export async function loadEarthTexture(): Promise<THREE.Texture> {
  // Load level 2 (8192×4096) as a good default
  return assembleLevel(LEVELS[2])
}
