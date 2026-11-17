import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { build } from 'esbuild'
import { createBuildIdentity } from '../scripts/build-identity.mjs'

const root = resolve('artifacts')
const version = JSON.parse(await readFile('package.json', 'utf8')).version

interface LogHeader {
  event: string
  plugin?: ReturnType<typeof createBuildIdentity>
}

function exportedLogHeaders(zip: Buffer) {
  const logs: Record<string, LogHeader> = {}
  let offset = 0
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const name = zip.toString('utf8', offset + 30, offset + 30 + nameLength)
    const start = offset + 30 + nameLength + zip.readUInt16LE(offset + 28)
    if (name.startsWith('logs/')) {
      const firstLine = zip.toString('utf8', start, start + size).split('\n')[0]
      logs[name] = JSON.parse(firstLine)
    }
    offset = start + size
  }
  return logs
}

test('actual diagnostics, application projection and JSONL header use the frozen build receipt', async () => {
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'r2-build-identity-'))
  const previousLocalAppData = process.env.LOCALAPPDATA
  const identities = [createBuildIdentity(version), createBuildIdentity(version)]
  try {
    const receipts = []
    for (const [index, identity] of [...identities, undefined].entries()) {
      const outdir = join(directory, String(index))
      process.env.LOCALAPPDATA = join(outdir, 'diagnostics-root')
      await build({
        entryPoints: ['src/index.ts', 'src/worker.ts'],
        outdir, bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24',
        define: identity ? { __DSH_PLUGIN_BUILD__: JSON.stringify(identity) } : {},
      })
      const plugin = await import(pathToFileURL(join(outdir, 'index.js')).href)
      const ctx = new Context()
      try {
        await ctx.plugin(SystemPrompt, {})
        await ctx.plugin(ToolRuntime, {})
        await ctx.plugin(NativeToolExecutor)
        await ctx.plugin(ComputerUseRegistry)
        await ctx.plugin(plugin, {})
        // Exercise the registered application tool's response projection without launching a desktop.
        ctx.virtualDesktop.openApplicationApproved = async () => ({
          operationId: randomUUID(), status: 'ready', stage: 'ready', path: 'fixture.exe', message: 'fixture ready',
        })
        async function call(name: string, args: object = {}, isError = false) {
          const { results } = await ctx.tools.execute({
            calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) }],
            signal: AbortSignal.timeout(10_000),
          })
          const result = results[0].result
          assert.equal(result.isError, isError, JSON.stringify(result.content))
          return JSON.parse(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
        }
        const diagnostic = await call('desktop_get_diagnostics')
        assert.equal(diagnostic.diagnosticChannel.status, 'ready')
        assert.equal(diagnostic.desktop.status, 'disabled')
        assert.deepEqual(diagnostic.plugin, identity, 'diagnostics reply differs from its build identity')
        assert.equal(Object.hasOwn(diagnostic, 'plugin'), Boolean(identity))
        assert.deepEqual((await call('desktop_get_diagnostics')).plugin, identity)
        const application = await call('desktop_open_application', { appId: 'vmware-workstation' })
        assert.equal(application.status, 'ready')
        assert.deepEqual(application.plugin, identity)
        assert.equal(Object.hasOwn(application, 'plugin'), Boolean(identity))
        ctx.virtualDesktop.openApplicationApproved = async () => { throw new Error('fixture denied') }
        const failed = await call('desktop_open_application', { appId: 'vmware-workstation' }, true)
        assert.equal(failed.error, 'fixture denied')
        assert.deepEqual(failed.plugin, identity)
        assert.equal(Object.hasOwn(failed, 'plugin'), Boolean(identity))
        if (identity) {
          const firstExport = await call('desktop_export_diagnostics')
          const firstLog = exportedLogHeaders(await readFile(firstExport.filePath))['logs/runtime.jsonl']
          assert.equal(firstLog?.event, 'plugin-build')
          assert.deepEqual(firstLog?.plugin, identity)
          if (index === 0) {
            for (let entry = 0; entry < 35; entry++) {
              ctx.virtualDesktop.recordToolFailure('rotation-fixture', { message: 'x'.repeat(31000) })
            }
            const rotated = await call('desktop_export_diagnostics')
            const logs = exportedLogHeaders(await readFile(rotated.filePath))
            assert.deepEqual(Object.keys(logs), ['logs/runtime.jsonl', 'logs/runtime.1.jsonl'])
            for (const header of Object.values(logs)) {
              assert.equal(header?.event, 'plugin-build')
              assert.deepEqual(header?.plugin, identity)
            }
          }
          receipts.push(diagnostic.plugin)
        }
      } finally {
        await ctx.fiber.dispose()
      }
    }
    assert.notEqual(receipts[0].buildHash, receipts[1].buildHash)
    console.info(JSON.stringify({ receipts, missingInjectionOmitted: true, rotatedHeaderVerified: true }))
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocalAppData
    const target = await realpath(directory)
    const within = relative(await realpath(root), target)
    assert.match(within, /^r2-build-identity-[^\\/]+$/)
    assert.ok(!isAbsolute(within))
    await rm(target, { recursive: true, force: true })
  }
})
