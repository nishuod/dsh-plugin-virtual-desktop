import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, basename } from 'node:path'
import { verifyTarball, readTarball } from './verify-package.mjs'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
if (!/^1\.\d+\.\d+(?:-rc\.\d+)?$/.test(manifest.version)) throw new Error('Expected a stable or rc release version')
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
if (lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) throw new Error('Manifest and lockfile versions differ')
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${manifest.version}`) throw new Error('Tag does not match package version')
if (!process.env.npm_execpath) throw new Error('Run npm run release:prepare')
const npm = (args, capture = false) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit'})
// Keep the canonical archive available to a profile that still references it.
const destination = resolve(process.env.DSH_RELEASE_ROOT ?? 'artifacts/releases', manifest.version)
await mkdir(destination, { recursive: true })
npm(['run', 'build'])
execFileSync(process.execPath,['scripts/export-public-api.mjs','--check'],{stdio:'inherit'})
npm(['test'])
const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', destination], true))
if (packed.filename !== `${manifest.name}-${manifest.version}.tgz`) throw new Error('Packed filename does not match manifest version')
const current = resolve(destination, basename(packed.filename))
const verification = await verifyTarball(current)
if (verification.package !== manifest.name || verification.version !== manifest.version) throw new Error('Packed manifest does not match release version')
npm(['run','verify:install','--',current])
const sha256 = path => readFile(path).then(data => createHash('sha256').update(data).digest('hex'))
const currentHash = await sha256(current)
const smoke = JSON.parse(await readFile('artifacts/install-smoke/latest.json', 'utf8'))
if (smoke.status !== 'passed' || smoke.sha256 !== currentHash || smoke.probe?.plugin?.version !== manifest.version) {
  throw new Error('Isolated install did not verify this archive and build')
}
const hashes = [`${currentHash}  ${basename(current)}`]
let versions = []
try { versions = JSON.parse(npm(['view', manifest.name, 'versions', '--json', '--registry=https://registry.npmjs.org/'], true)) }
catch (error) { if (!/E404/.test(String(error.stderr))) throw error }
if (!Array.isArray(versions)) versions = [versions]
const previous = versions.filter(version => version !== manifest.version).at(-1)
let rollbackPackage = null
let rollbackStatus = 'first-registry-release-no-previous-package'
if (previous) {
  const rollback = resolve(destination, 'rollback')
  await mkdir(rollback, { recursive: true })
  const [saved] = JSON.parse(npm(['pack', `${manifest.name}@${previous}`, '--ignore-scripts', '--json', '--registry=https://registry.npmjs.org/', '--pack-destination', rollback], true))
  const path = resolve(rollback, basename(saved.filename))
  rollbackPackage = `rollback/${basename(path)}`
  rollbackStatus = 'previous-registry-package-retained'
  hashes.push(`${await sha256(path)}  ${rollbackPackage}`)
} else {
  const rc = /^(.*-rc\.)(\d+)$/.exec(manifest.version)
  const priorVersion = rc && Number(rc[2]) > 1 ? rc[1] + (Number(rc[2]) - 1) : undefined
  const candidates = []
  if (priorVersion) {
    const directory = resolve('artifacts/releases', priorVersion)
    candidates.push({ version: priorVersion, file: resolve(directory, `${manifest.name}-${priorVersion}.tgz`), checksums: resolve(directory, 'SHA256SUMS') })
  }
  candidates.push({ version: '0.5.0-preview.14', file: resolve('artifacts', `${manifest.name}-0.5.0-preview.14.tgz`) })
  for (const candidate of candidates) {
    const data = await readFile(candidate.file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!data) continue
    const old = JSON.parse(readTarball(data).find(entry => entry.path === 'package/package.json')?.data.toString() ?? '{}')
    if (old.name !== manifest.name || old.version !== candidate.version) throw new Error('Local rollback package identity mismatch')
    const hash = createHash('sha256').update(data).digest('hex')
    const filename = basename(candidate.file)
    if (candidate.checksums) {
      const checksums = await readFile(candidate.checksums, 'utf8')
      if (!checksums.split(/\r?\n/).some(line => line.trim() === `${hash}  ${filename}`)) throw new Error('Local rollback package checksum mismatch')
    }
    const rollback = resolve(destination, 'rollback')
    await mkdir(rollback, { recursive: true })
    await writeFile(resolve(rollback, filename), data)
    rollbackPackage = `rollback/${filename}`
    rollbackStatus = candidate.checksums ? 'previous-local-candidate-retained' : 'local-preview14-baseline-retained-unmodified'
    hashes.push(`${hash}  ${rollbackPackage}`)
    break
  }
}
await writeFile(resolve(destination, 'SHA256SUMS'), `${hashes.join('\n')}\n`)
await writeFile(resolve(destination, 'release.json'), JSON.stringify({createdAt: new Date().toISOString(), ...verification, sha256: currentHash, plugin: smoke.probe.plugin, rollbackPackage, rollbackStatus, published: false}, null, 2) + '\n')
console.log(`Verified release prepared at ${destination}; publication is a separate step.`)
