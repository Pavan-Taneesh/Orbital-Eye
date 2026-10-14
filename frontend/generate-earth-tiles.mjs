import * as THREE from 'three'

function loadImage(
  src: string,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()

    image.onload = () => {
      console.log(
        `✓ Loaded ${src} (${image.width}x${image.height})`,
      )

      resolve(image)
    }

    image.onerror = () => {
      reject(
        new Error(
          `Failed to load tile: ${src}`,
        ),
      )
    }

    image.src = src
  })
}

export async function loadEarthTexture(): Promise<THREE.CanvasTexture> {
  // ==========================================================
  // EARTH LEVEL
  // ==========================================================

  // Level 2 = 4096 × 2048
  //
  // 8 columns × 4 rows
  //
  // 32 tiles total

  const level = 2

  const tileSize = 512

  const columns = 8
  const rows = 4

  const width =
    columns * tileSize

  const height =
    rows * tileSize


  // ==========================================================
  // CREATE CANVAS
  // ==========================================================

  const canvas =
    document.createElement('canvas')

  canvas.width = width
  canvas.height = height

  const ctx =
    canvas.getContext('2d')

  if (!ctx) {
    throw new Error(
      'Could not create 2D canvas',
    )
  }


  console.log('')
  console.log(
    '🌍 Starting Earth texture assembly',
  )

  console.log(
    `🌍 Level: ${level}`,
  )

  console.log(
    `🌍 Canvas: ${width} × ${height}`,
  )

  console.log(
    `🌍 Tiles: ${columns} × ${rows}`,
  )


  // ==========================================================
  // LOAD ALL TILES
  // ==========================================================

  const tiles: HTMLImageElement[][] =
    []

  for (let y = 0; y < rows; y++) {
    tiles[y] = []

    for (let x = 0; x < columns; x++) {
      const url =
        `/earth-tiles/${level}/${y}/${x}.jpg`

      console.log(
        `Loading ${url}`,
      )

      tiles[y][x] =
        await loadImage(url)
    }
  }


  // ==========================================================
  // ASSEMBLE CANVAS
  // ==========================================================

  console.log(
    '🌍 All Earth tiles loaded',
  )

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const image =
        tiles[y][x]

      const left =
        x * tileSize

      const top =
        y * tileSize

      ctx.drawImage(
        image,
        left,
        top,
        tileSize,
        tileSize,
      )
    }
  }


  console.log(
    '🌍 Earth canvas assembled',
  )


  // ==========================================================
  // DEBUG
  // ==========================================================

  try {
    const preview =
      canvas.toDataURL(
        'image/jpeg',
        0.8,
      )

    console.log(
      '🌍 Canvas preview generated:',
      preview.substring(
        0,
        60,
      ),
    )
  } catch (error) {
    console.error(
      '❌ Canvas preview failed:',
      error,
    )
  }


  // ==========================================================
  // THREE.JS TEXTURE
  // ==========================================================

  const texture =
    new THREE.CanvasTexture(
      canvas,
    )

  texture.colorSpace =
    THREE.SRGBColorSpace

  texture.wrapS =
    THREE.ClampToEdgeWrapping

  texture.wrapT =
    THREE.ClampToEdgeWrapping

  texture.minFilter =
    THREE.LinearMipmapLinearFilter

  texture.magFilter =
    THREE.LinearFilter

  texture.anisotropy = 4

  texture.needsUpdate = true


  console.log(
    '🌍 Three.js CanvasTexture created',
  )

  console.log(
    '🌍 Earth texture ready',
  )


  return texture
}