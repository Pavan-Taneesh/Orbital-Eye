import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { get } from 'node:https'
import { resolve } from 'node:path'

// Solar System Scope 8K Earth textures (CC BY 4.0)
// https://www.solarsystemscope.com/textures/
const textures = [
  {
    name: 'Earth Day Map (8K)',
    url: 'https://www.solarsystemscope.com/textures/download/8k_earth_daymap.jpg',
    filename: '8k_earth_daymap.jpg',
  },
  {
    name: 'Earth Night Map (8K)',
    url: 'https://www.solarsystemscope.com/textures/download/8k_earth_nightmap.jpg',
    filename: '8k_earth_nightmap.jpg',
  },
  {
    name: 'Earth Clouds (8K)',
    url: 'https://www.solarsystemscope.com/textures/download/8k_earth_clouds.jpg',
    filename: '8k_earth_clouds.jpg',
  },
]

const outputDir = resolve('source-textures')
mkdirSync(outputDir, { recursive: true })

function download(targetUrl, outputPath, label) {
  return new Promise((resolvePromise, reject) => {
    if (existsSync(outputPath)) {
      console.log(`✓ ${label} already exists`)
      resolvePromise()
      return
    }

    console.log(`⬇  Downloading ${label}...`)

    const doRequest = (url) => {
      get(url, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          doRequest(response.headers.location)
          return
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${url}`))
          return
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
        let downloadedBytes = 0
        let lastPercent = -1

        const file = createWriteStream(outputPath)

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length
          if (totalBytes > 0) {
            const percent = Math.floor((downloadedBytes / totalBytes) * 100)
            if (percent !== lastPercent && percent % 10 === 0) {
              lastPercent = percent
              const mb = (downloadedBytes / 1024 / 1024).toFixed(1)
              process.stdout.write(`\r   ${label}: ${mb} MB (${percent}%)`)
            }
          }
        })

        response.pipe(file)

        file.on('finish', () => {
          file.close()
          const mb = (downloadedBytes / 1024 / 1024).toFixed(1)
          console.log(`\r   ✓ ${label}: ${mb} MB`)
          resolvePromise()
        })

        file.on('error', reject)
      }).on('error', reject)
    }

    doRequest(targetUrl)
  })
}

console.log('')
console.log('🌍 Downloading Solar System Scope Earth textures (8K, CC BY 4.0)')
console.log('   Source: https://www.solarsystemscope.com/textures/')
console.log('')

for (const { name, url, filename } of textures) {
  const outputPath = resolve(outputDir, filename)
  await download(url, outputPath, name)
}

console.log('')
console.log('✓ All Earth textures downloaded!')
console.log(`  Location: ${outputDir}`)
