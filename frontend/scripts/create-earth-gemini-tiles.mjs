import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

// ============================================================
// Configuration
// ============================================================

const source = path.resolve('source-textures/blue-marble-21600x10800.jpg')
const outputDirectory = path.resolve('public/earth-tiles')

// Native source: 21600 × 10800
// Each level is a power-of-2 grid of 1024×1024 tiles

const levels = [
  { level: 0, width: 2048,  height: 1024, cols: 2,  rows: 1 },
  { level: 1, width: 4096,  height: 2048, cols: 4,  rows: 2 },
  { level: 2, width: 8192,  height: 4096, cols: 8,  rows: 4 },
  { level: 3, width: 16384, height: 8192, cols: 16, rows: 8 },
]

const TILE_SIZE = 1024

// ============================================================
// Check source exists
// ============================================================

if (!existsSync(source)) {
  console.error('✗ Source image not found:', source)
  console.error('  Run: node scripts/download-earth-texture.mjs')
  process.exit(1)
}

// ============================================================
// Clean output directory
// ============================================================

if (existsSync(outputDirectory)) {
  console.log('🧹 Cleaning old tiles...')
  await rm(outputDirectory, { recursive: true })
}

await mkdir(outputDirectory, { recursive: true })

// ============================================================
// Generate tiles for each level
// ============================================================

console.log('')
console.log('🌍 Generating Earth tile pyramid from NASA Blue Marble')
console.log(`   Source: ${source}`)
console.log(`   Output: ${outputDirectory}`)
console.log('')

for (const { level, width, height, cols, rows } of levels) {
  console.log(`━━━ Level ${level}: ${width}×${height} (${cols}×${rows} = ${cols * rows} tiles) ━━━`)

  const startTime = Date.now()

  // Resize to this level's resolution
  const resized = await sharp(source, { limitInputPixels: false })
    .resize(width, height, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  console.log(`   Resized in ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

  // Create level directory
  const levelDir = path.join(outputDirectory, String(level))

  // Extract tiles
  for (let row = 0; row < rows; row++) {
    const rowDir = path.join(levelDir, String(row))
    await mkdir(rowDir, { recursive: true })

    const tilePromises = []

    for (let col = 0; col < cols; col++) {
      const left = col * TILE_SIZE
      const top = row * TILE_SIZE

      const promise = sharp(resized.data, {
        raw: {
          width: resized.info.width,
          height: resized.info.height,
          channels: resized.info.channels,
        },
      })
        .extract({ left, top, width: TILE_SIZE, height: TILE_SIZE })
        .webp({ quality: 92, effort: 4 })
        .toFile(path.join(rowDir, `${col}.webp`))

      tilePromises.push(promise)
    }

    await Promise.all(tilePromises)
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`   ✓ Level ${level} complete (${elapsed}s)`)
  console.log('')
}

// ============================================================
// Summary
// ============================================================

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('✓ Earth tile pyramid generated successfully!')
console.log(`  Levels: 0-${levels.length - 1}`)
console.log(`  Tile size: ${TILE_SIZE}×${TILE_SIZE}`)
console.log(`  Total tiles: ${levels.reduce((sum, l) => sum + l.cols * l.rows, 0)}`)
console.log(`  Output: ${outputDirectory}`)
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
