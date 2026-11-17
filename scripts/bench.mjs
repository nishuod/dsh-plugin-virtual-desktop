import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'

// Reproducible synthetic content. No desktop is captured and no model is called.
const width = 1600, height = 900, pixels = Buffer.alloc(width * height * 3)
let seed = 20261112
for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = (seed >>> 24) & 255 }
const profiles = [{name: 'baseline', dimension: 1280, quality: 75}, {name: 'economy', dimension: 640, quality: 75}]
const measurements = []
for (const profile of profiles) {
  const samples = []
  for (let step = -2; step < 20; step++) {
    const start = performance.now()
    const {data, info} = await sharp(pixels, {raw: {width, height, channels: 3}}).resize({width: profile.dimension, height: profile.dimension, fit: 'inside', withoutEnlargement: true}).jpeg({quality: profile.quality}).toBuffer({resolveWithObject: true})
    if (step >= 0) samples.push({step: step + 1, encodingMs: performance.now() - start, bytes: data.length, width: info.width, height: info.height, estimatedImageTokens: Math.ceil(info.width / 512) * Math.ceil(info.height / 512) * 170 + 85})
  }
  const mean = key => samples.reduce((sum, value) => sum + value[key], 0) / samples.length
  measurements.push({...profile, steps: samples.length, meanEncodingMs: mean('encodingMs'), meanBytes: mean('bytes'), estimatedImageTokensPerStep: mean('estimatedImageTokens'), samples})
}
const report = {timestamp: new Date().toISOString(), kind: 'synthetic-local-encoding-microbenchmark', environment: {platform: process.platform, arch: process.arch, node: process.version, cpu: os.cpus()[0]?.model}, liveDesktopLatencyMs: null, modelLatencyMs: null, tokenEstimate: 'Illustrative 512px tile heuristic: 85 + 170 * ceil(width/512) * ceil(height/512). Not an actual provider token count or cost claim.', measurements}
await mkdir('artifacts/bench', {recursive: true})
await writeFile('artifacts/bench/latest.json', JSON.stringify(report, null, 2) + '\n')
const rows = measurements.map(value => `| ${value.name} | ${value.steps} | ${value.dimension} | ${value.quality} | ${value.meanEncodingMs.toFixed(2)} | ${Math.round(value.meanBytes)} | ${value.estimatedImageTokensPerStep} |`)
await writeFile('artifacts/bench/latest.md', `# Encoding microbenchmark\n\n${report.timestamp}; ${report.environment.platform}/${report.environment.arch}; Node ${report.environment.node}.\n\n20 measured encoding steps after two warmups per profile. Synthetic RGB noise, 1600x900. No desktop capture, UIA, input, model request or application readback is included. **Live 20-step action latency remains unverified.**\n\n| Profile | Steps | Max dimension | JPEG quality | Mean encoding ms | Mean bytes | Illustrative tokens |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\n${report.tokenEstimate}\n\nThe economy comparison measures size/quality settings only. Use the runtime screenshot limits and crop configuration to reduce images; pure UIA and changed-region-only operation require separate implementation and live acceptance.\n`)
console.log(JSON.stringify({...report, measurements: measurements.map(({samples, ...summary}) => summary)}, null, 2))
