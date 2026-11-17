import { mkdir, cp, copyFile, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator'

// The public generator consumes workspace aggregates. Stage our single package in
// that documented shape; no Harness checkout or core patch is needed.
const root = resolve('.typert-workspace')
const pkg = resolve(root, 'packages/virtual-desktop')
await mkdir(pkg, { recursive: true })
await cp('src', resolve(pkg, 'src'), { recursive: true })
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
// Only the controller is a Remote contribution; ordinary tool/config types are
// checked by the Host compiler and must not pull the entire Agent graph into it.
manifest.exports['.'] = { types: './lib/types/controller.d.ts', default: './lib/controller.js' }
delete manifest.exports['./client']
await writeFile(resolve(pkg, 'package.json'), JSON.stringify(manifest))
// The generator identifies protocol decorators by registered package identity.
// Register an untouched copy of the published protocol declarations as a build
// dependency. These SDK files are not bundled into our package or changed.
const protocol = resolve(root, 'packages/typert-protocol')
await cp('node_modules/@deepseek-ai/dsh-typert-protocol', protocol, { recursive: true })
async function stageDeclarations(directory, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await stageDeclarations(resolve(directory, entry.name), resolve(target, entry.name))
    else if (entry.name.endsWith('.d.ts')) await copyFile(resolve(directory, entry.name), resolve(target, entry.name.replace(/\.d\.ts$/, '.ts')))
  }
}
await stageDeclarations(resolve(protocol, 'lib/types'), resolve(protocol, 'src'))
await writeFile(resolve(protocol, 'tsconfig.host.json'), JSON.stringify({
  compilerOptions: { target: 'ES2023', lib: ['ES2023', 'ESNext.Disposable', 'DOM'], module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true },
  include: ['src/**/*.ts'],
}))
const leaf = JSON.parse(await readFile('tsconfig.host.json', 'utf8'))
leaf.compilerOptions.paths = { '@deepseek-ai/dsh-typert-protocol': ['../typert-protocol/src/index.ts'] }
leaf.compilerOptions.rootDir = '..'
leaf.include = ['src/controller.ts', 'src/diagnostics.ts']
await writeFile(resolve(pkg, 'tsconfig.host.json'), JSON.stringify(leaf))
const config = JSON.parse(await readFile('tsconfig.host.json', 'utf8'))
config.compilerOptions.emitDeclarationOnly = false
config.compilerOptions.noEmit = true
config.compilerOptions.paths = { '@deepseek-ai/dsh-typert-protocol': ['./packages/typert-protocol/src/index.ts'] }
config.references = [{ path: './packages/virtual-desktop/tsconfig.host.json' }, { path: './packages/typert-protocol/tsconfig.host.json' }]
config.files = []; config.include = []
await writeFile(resolve(root, 'tsconfig.host.json'), JSON.stringify(config))
const artifacts = new WorkspaceTypertGenerator(root).generate(['dsh-plugin-virtual-desktop'], ['host'])
if (artifacts.length !== 1) throw new Error(`Expected one Host contribution, received ${artifacts.length}`)
writeWorkspaceArtifacts(root, artifacts)
await mkdir('lib', { recursive: true })
for (const file of await readdir(resolve(pkg, 'lib'))) {
  if (file.startsWith('typert.') && !file.endsWith('.map')) {
    const source = await readFile(resolve(pkg, 'lib', file), 'utf8')
    await writeFile(resolve('lib', file), source.replace(/^\/\/[#@] sourceMappingURL=.*$/gm, ''))
  }
}
console.log('Generated strict Host reflection and Client Remote descriptors using DSH Typert')
