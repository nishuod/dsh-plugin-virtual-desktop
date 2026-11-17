import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { createBuildIdentity } from './build-identity.mjs'
// Source maps from older builds may contain embedded private source. Remove
// only generated map files inside the verified output directory.
const output = resolve('lib')
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const pluginBuild = createBuildIdentity(version)
async function removeMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = resolve(directory, entry.name)
    if (relative(output, path).startsWith('..')) throw new Error('Output escaped lib')
    if (entry.isDirectory()) await removeMaps(path)
    else if (entry.name.endsWith('.map')) await rm(path)
  }
}
await removeMaps(output)
await mkdir('lib/tools', { recursive: true })
await copyFile('cordis.patch.yml', 'lib/cordis.patch.yml')
await copyFile('scripts/Set-MinimizedRdpCompatibility.ps1', 'lib/tools/Set-MinimizedRdpCompatibility.ps1')
if (process.platform === 'win32' && process.arch === 'x64') {
  execFileSync('dotnet', [
    'build', 'prototype/ChildSessionHost/ChildSessionHost.csproj', '-c', 'Release',
    '-o', 'lib/child-session-host', '-p:DebugType=None',
  ], { stdio: 'inherit' })
}
await build({ entryPoints: ['src/index.ts', 'src/worker.ts', 'src/worker-client.ts', 'src/diagnostics.ts','src/native-worker.ts','src/native-runtime.ts','src/native-client.ts','src/child-session-bridge.ts'], outdir: 'lib',
  bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', sourcemap: false,
  define: { __DSH_PLUGIN_BUILD__: JSON.stringify(pluginBuild) } })
await build({ entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js',
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-plugin-virtual-desktop",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' }, sourcemap: false })
