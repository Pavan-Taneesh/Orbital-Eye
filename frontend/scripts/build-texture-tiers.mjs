#!/usr/bin/env node
// Builds downscaled texture tiers from the 8K sources in public/textures.
//   public/textures/low/  2048x1024
//   public/textures/mid/  4096x2048
// The original 8k_* files stay in place and serve as the "high" tier.
// Idempotent: an output is skipped when it is newer than its source.
// Usage: npm run textures   (add --force to rebuild everything)

import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const texDir = path.join(root, 'public', 'textures')
const force = process.argv.includes('--force')

const TIERS = {
  low: { width: 2048, height: 1024 },
  mid: { width: 4096, height: 2048 },
}

const SOURCES = [
  { src: '8k_earth_daymap.jpg', out: 'earth_day.jpg', quality: 80 },
  { src: '8k_earth_nightmap.jpg', out: 'earth_night.jpg', quality: 80 },
  // Used as a color map with alpha-from-opacity: grayscale is enough and much smaller.
  { src: '8k_earth_clouds.jpg', out: 'earth_clouds.jpg', quality: 80, grayscale: true },
  // Normal map: higher quality, no chroma subsampling (RGB channels encode XYZ).
  { src: '8k_earth_normal_map.png', out: 'earth_normal.jpg', quality: 88, chromaSubsampling: '4:4:4' },
  { src: '8k_stars_milky_way.jpg', out: 'stars.jpg', quality: 80 },
]

async function mtime(file) {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return null
  }
}

function fmt(bytes) {
  return `${(bytes / 1024).toFixed(0)} KB`
}

let built = 0
let skipped = 0

for (const [tier, size] of Object.entries(TIERS)) {
  const outDir = path.join(texDir, tier)
  await mkdir(outDir, { recursive: true })

  for (const job of SOURCES) {
    const srcPath = path.join(texDir, job.src)
    const outPath = path.join(outDir, job.out)

    const srcTime = await mtime(srcPath)
    if (srcTime === null) {
      console.error(`missing source: ${srcPath}`)
      process.exitCode = 1
      continue
    }
    const outTime = await mtime(outPath)
    if (!force && outTime !== null && outTime > srcTime) {
      skipped++
      console.log(`skip  ${tier}/${job.out} (up to date)`)
      continue
    }

    let pipeline = sharp(srcPath, { limitInputPixels: false })
      .resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' })
    if (job.grayscale) pipeline = pipeline.grayscale()
    pipeline = pipeline.jpeg({
      quality: job.quality,
      mozjpeg: true,
      ...(job.chromaSubsampling ? { chromaSubsampling: job.chromaSubsampling } : {}),
    })

    const info = await pipeline.toFile(outPath)
    built++
    console.log(`built ${tier}/${job.out} ${info.width}x${info.height} ${fmt(info.size)}`)
  }
}

console.log(`done: ${built} built, ${skipped} skipped`)
