// Integration through the built Cordis tools, using one owned VMware session.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { stat, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import koffi from 'koffi'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import * as plugin from '../lib/index.js'
import { decodeChildAssociation } from '../scripts/eval-contract.mjs'

assert.ok(process.argv.includes('--run-owned-test'), 'Pass --run-owned-test explicitly')
const wts = koffi.load('wtsapi32.dll')
const kernel = koffi.load('kernel32.dll')
const query = wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
const readError = kernel.func('uint32_t __stdcall GetLastError()')
const clearError = kernel.func('void __stdcall SetLastError(uint32_t error)')
function associated() {
  const id = [0]
  clearError(0)
  const status = query(id)
  return decodeChildAssociation(status, id[0], readError())
}
assert.equal(associated(), null, 'Existing Windows child association: refusing to change it')
const ctx = new Context()
const signal = () => AbortSignal.timeout(90_000)
const report = { timestamp: new Date().toISOString(), passed: false }
const agent = { session: { requestHeader: () => undefined }, options: { provider: 'test', model: 'vision' } }
async function run(name, args = {}) {
  const { results } = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) }],
    signal: signal(), agent,
  })
  const result = results[0].result
  const block = result.content.find(block => block.type === 'text')
  assert.equal(result.isError, false, block?.text)
  return result.structuredContent ?? JSON.parse(block.text)
}
async function verifyImage(receipt) {
  assert.ok(isAbsolute(receipt.filePath))
  assert.ok((await stat(receipt.filePath)).isFile())
  const decoded = await sharp(receipt.filePath).raw().toBuffer({ resolveWithObject: true })
  assert.ok(decoded.data.length > 0)
  return { width: decoded.info.width, height: decoded.info.height, readImageArgumentMatches: receipt.nextToolArgs?.file_path === receipt.filePath }
}
let controller
try {
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ComputerUseRegistry)
  // The test authorizes only its own fixture calls, with no session-wide permission.
  ctx.provide('approval', { request: async () => 'allowed-once' })
  ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['image'] }) })
  await ctx.plugin(plugin, {})
  controller = ctx.virtualDesktop
  const resetSchema = ctx.tools.schemas().find(tool => tool.name === 'desktop_reset_child_session')
  assert.ok(resetSchema)
  assert.deepEqual(Object.keys(resetSchema.parameters.properties), ['operationId'])
  assert.ok(!resetSchema.parameters.required?.length)
  const idle = await run('desktop_reset_child_session')
  assert.equal(idle.state, 'idle')
  assert.deepEqual(idle.releasedPids, [])
  report.idle = { state: idle.state, releasedPids: idle.releasedPids }

  const native = controller.native
  const state = await native.enable(signal(), 'windows-child-session')
  const owned = native.client
  const broker = owned?.process
  assert.ok(broker?.pid)
  assert.equal(state.childSessionId, associated())
  assert.notEqual(state.childSessionId, state.parentSessionId)
  report.brokerPid = broker.pid
  assert.ok(broker.kill(), 'Could not stop the exact broker process created by the test')
  await owned.exit
  report.associationAfterKill = associated()
  assert.equal(report.associationAfterKill, state.childSessionId, 'Watchdog already released the association before reset')
  const operationId = randomUUID()
  const reset = await run('desktop_reset_child_session', { operationId })
  report.reset = { state: reset.state, releasedPids: reset.releasedPids, association: associated() }
  assert.equal(reset.state, 'released')
  assert.deepEqual(reset.releasedPids, [broker.pid])
  assert.equal(report.reset.association, null)

  const opened = await run('desktop_open_application', { appId: 'vmware-workstation' })
  report.openStatus = opened.status
  assert.equal(opened.status, 'ready', opened.message)
  report.openImage = await verifyImage(opened)
  const frame = await run('desktop_get_screenshot')
  report.screenshot = await verifyImage(frame)
  assert.ok(report.screenshot.readImageArgumentMatches)
  assert.deepEqual(await run('desktop_reset_child_session', { operationId }), reset)
  assert.equal(associated(), opened.childSessionId)
  report.replayPreservedReopenedSession = true
  const metadata = await run('desktop_get_screenshot', { mode: 'uia' })
  assert.equal(metadata.imageMode, 'uia-only')
  assert.equal(metadata.filePath, undefined)
  report.uiaOnly = true
  report.passed = true
} catch (error) {
  report.error = error?.message ?? String(error)
  process.exitCode = 1
} finally {
  try {
    if (controller) await controller.resetChildSession(randomUUID(), signal())
    report.finalAssociation = associated()
    assert.equal(report.finalAssociation, null)
  } catch (error) {
    report.cleanupError = error?.message ?? String(error)
    report.passed = false
    process.exitCode = 1
  }
  await ctx.fiber.dispose()
  await writeFile(resolve('evidence/b1-b2-live.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
