import { readFile, realpath } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function validatePackageEntries(entries, manifest) {
  const errors = []
  const rootFiles = new Set(['package.json', 'README.md', 'README.zh-CN.md', 'LICENSE'])
  const paths = new Set(entries.map(entry => entry.path.replace(/^package\//, '')))
  if (paths.size !== entries.length) errors.push('Duplicate archive path')
  for (const entry of entries) {
    const path = entry.path.replace(/^package\//, '')
    if (path.includes('..') || path.includes('\\') || path.startsWith('/') || !/^(lib|types|docs)\//.test(path) && !rootFiles.has(path)) errors.push(`Unexpected package file: ${path}`)
    if (/(^|\/)(src|evidence|artifacts|node_modules|backups|tests|\.git)(\/|$)/i.test(path)) errors.push(`Private directory: ${path}`)
    if (/\.(?:tsx?|cs|pdb|map)$/i.test(path) && !path.endsWith('.d.ts')) errors.push(`Source or debug file: ${path}`)
    if (entry.type && !['0', '\0'].includes(entry.type)) errors.push(`Non-regular archive entry: ${path}`)
    if (entry.data && /\.(?:js|d\.ts)$/.test(path) && /sourceMappingURL=|"sourcesContent"\s*:/.test(entry.data.toString())) errors.push(`Embedded source map: ${path}`)
  }
  for (const path of ['package.json', 'lib/index.js', 'lib/client.js', 'lib/cordis.patch.yml', 'lib/child-session-host/ChildSessionHost.exe', 'lib/types/index.d.ts']) {
    if (!paths.has(path)) errors.push(`Required runtime missing: ${path}`)
  }
  for (const path of ['docs/PUBLIC-API.md', 'docs/PUBLIC-API.schema.json', 'docs/PUBLIC-API.responses.schema.json', 'docs/PUBLIC-API.config.schema.json', 'docs/PRIVACY.md', 'docs/SECURITY.md']) {
    if (!paths.has(path)) errors.push(`Required release document missing: ${path}`)
  }
  if (manifest) {
    const targets = [manifest.main, manifest.types, manifest.dsh?.bundle?.patch]
    function add(value) { if (typeof value === 'string') targets.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(add) }
    add(manifest.exports)
    for (const target of targets.filter(Boolean)) if (!paths.has(target.replace(/^\.\//, ''))) errors.push(`Unresolved package entry: ${target}`)
    if (JSON.stringify({...manifest.dependencies,...manifest.optionalDependencies,...manifest.peerDependencies}).includes('file:')) errors.push('Local runtime dependency')
  }
  return errors
}

export function readTarball(buffer) {
  const tar = gunzipSync(buffer), entries = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const string = (start, end) => header.subarray(start, end).toString().replace(/\0.*$/, '')
    const size = parseInt(string(124, 136).trim(), 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Malformed tar entry')
    const name = string(0, 100), prefix = string(345, 500)
    entries.push({path: prefix ? `${prefix}/${name}` : name, type: string(156, 157) || '\0', data: tar.subarray(offset + 512, offset + 512 + size)})
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

export async function verifyTarball(path) {
  const entries = readTarball(await readFile(path))
  const manifest = JSON.parse(entries.find(entry => entry.path === 'package/package.json')?.data.toString() ?? '{}')
  const errors = validatePackageEntries(entries, manifest)
  if (errors.length) throw new Error(errors.join('\n'))
  return {package: manifest.name, version: manifest.version, files: entries.length, sourceFiles: 0, sourcemaps: 0, declarationsAllowed: true}
}

// Windows profiles can resolve through a drive junction (C: -> D: here).
// Compare physical paths so a direct CLI invocation cannot silently skip checks.
if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === await realpath(fileURLToPath(import.meta.url))) {
  if (process.argv[2]) console.log(JSON.stringify(await verifyTarball(process.argv[2]), null, 2))
  else {
    if (!process.env.npm_execpath) throw new Error('Run npm run verify:package or provide an actual .tgz path')
    const [packed] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'], {encoding: 'utf8'}))
    const manifest = JSON.parse(await readFile('package.json', 'utf8'))
    const errors = validatePackageEntries(packed.files, manifest)
    if (errors.length) throw new Error(errors.join('\n'))
    console.log(JSON.stringify({mode: 'pack-dry-run', files: packed.files.length, status: 'passed'}))
  }
}
