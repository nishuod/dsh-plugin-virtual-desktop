import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'
import { TYPERT as contribution } from '../lib/typert.host.js'
import remote from '../lib/typert.remote-client.js'

async function host() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ComputerUseRegistry)
  return ctx
}
test('real Cordis registers and executes the canonical diagnostic tool, then drains its process', async () => {
  const ctx = await host()
  try {
    const fiber = ctx.plugin(plugin, { workerTimeoutMs: 5000 }); await fiber
    const pid = ctx.virtualDesktop.snapshot().workerPid!
    assert.equal(ctx.computerUse.providerName, 'dsh-virtual-desktop-phase2')
    const { results } = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('diagnostic'), name: 'desktop_get_diagnostics', arguments: '{}' }],
      signal: new AbortController().signal,
    })
    const { result } = results[0]
    assert.equal(result.isError, false)
    assert.equal(result.value?.diagnosticChannel.nativeDesktop, false)
    assert.equal(result.value?.desktop.status, 'disabled')
    assert.equal(result.value?.desktop.activeBackend, null)
    assert.deepEqual(result.value?.desktop.capabilities, {
      windowCapture: false, desktopCapture: false, regionCapture: false, clipboard: false, autonomousTask: false,
    })
    assert.deepEqual(result.value?.pipProfile, {
      backend: 'windows-child-session', isolated: true,
      capabilities: { windowCapture: true, desktopCapture: false, regionCapture: true, clipboard: false, autonomousTask: false },
    })
    assert.equal(result.value?.nextTool, 'desktop_open_child_session')
    assert.equal(result.value?.desktop.window, null)
    assert.ok(ctx.tools.schemas().some(tool => tool.name === 'desktop_open_child_session'))
    assert.ok(ctx.tools.schemas().some(tool => tool.name === 'desktop_select_window'))
    assert.ok(result.content.some(block => block.type === 'text' && block.text.includes('diagnostic-only')))
    await fiber.dispose()
    assert.equal(ctx.get('virtualDesktop'), undefined)
    assert.equal(ctx.computerUse.providerName, undefined)
    assert.ok(!ctx.tools.schemas().some(tool => tool.name === 'desktop_get_diagnostics'))
    assert.throws(() => process.kill(pid, 0))
  } finally { await ctx.fiber.dispose() }
})
test('missing required service stays pending without spawning a worker', async () => {
  const ctx = new Context()
  try {
    const fiber = ctx.plugin(plugin)
    assert.equal(fiber.state, 0)
    assert.equal(ctx.get('virtualDesktop'), undefined)
    await fiber.dispose()
  } finally { await ctx.fiber.dispose() }
})
test('another provider is refused without removing its registration', async () => {
  const ctx = await host()
  try {
    ctx.computerUse.register(ComputerUseProviderName('existing-provider'))
    const fiber = ctx.plugin(plugin, { workerTimeoutMs: 5000 })
    await assert.rejects(Promise.resolve(fiber), /already registered/)
    await fiber.dispose()
    assert.equal(ctx.computerUse.providerName, 'existing-provider')
  } finally { await ctx.fiber.dispose() }
})
test('tool registration failure rolls back an already-started worker and provider', async () => {
  const ctx = await host()
  try {
    ctx.tools.register(defineTool({ name: 'desktop_get_diagnostics', description: 'collision fixture', parameters: {},
      output: { schema: { type: 'boolean' }, render: () => [] }, execute: async () => false }))
    const fiber = ctx.plugin(plugin, { workerTimeoutMs: 5000 })
    await assert.rejects(Promise.resolve(fiber))
    const state = ctx.get('virtualDesktop')?.snapshot()
    if (state?.workerPid) assert.throws(() => process.kill(state.workerPid!, 0))
    await fiber.dispose()
    assert.equal(ctx.computerUse.providerName, undefined)
    assert.equal(ctx.tools.schemas().filter(tool => tool.name === 'desktop_get_diagnostics').length, 1)
  } finally { await ctx.fiber.dispose() }
})
test('generated strict Gateway and Client codecs agree; malformed args are rejected', async () => {
  const ctx = await host()
  try {
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(contribution)
    ctx.provide('remoteAccess', { decide: async () => ({ allowed: false }) })
    await ctx.plugin(Gateway, {})
    await ctx.plugin(plugin, { workerTimeoutMs: 5000 })
    const peerCtx = new Context()
    const peer = { id: 'test-owner', ctx: peerCtx, principal: { kind: 'owner' }, signal: new AbortController().signal,
      interactions: 'none', dispose: () => peerCtx.fiber.dispose() }
    const request = { namespace: 'virtualDesktop', method: 'probe', args: {}, peer }
    const result = await ctx.typertGateway.invoke(request)
    const method = remote.methods['virtualDesktop/probe']
    assert.equal(method.result.create().parse(result).probes, 1)
    await assert.rejects(ctx.typertGateway.invoke({ ...request, args: { confirmed: true } }))
    const operationId = randomUUID()
    const reset = { ...request, method: 'resetChildSession', args: { operationId } }
    const resetMethod = remote.methods['virtualDesktop/resetChildSession']
    const receipt = resetMethod.result.create().parse(await ctx.typertGateway.invoke(reset))
    assert.equal(receipt.operationId, operationId)
    assert.equal(receipt.state, 'idle')
    assert.deepEqual(receipt.releasedPids, [])
    await assert.rejects(ctx.typertGateway.invoke({ ...reset, args: { operationId, pid: process.pid } }))
    await peer.dispose()
  } finally { await ctx.fiber.dispose() }
})
test('Remote rejects a non-owner even when called from an admitted peer', async () => {
  const ctx = await host()
  try {
    await ctx.plugin(plugin, { workerTimeoutMs: 5000 })
    const scoped = ctx.extend({ invocation: { peer: { principal: { kind: 'visitor' } } } })
    const failure = await scoped.virtualDesktop.remoteStatus(new AbortController().signal).catch(error => error)
    assert.equal(remoteErrorOf(failure)?.code, 'virtual-desktop/owner-required')
    const child = await scoped.virtualDesktop.enableChildSession(new AbortController().signal).catch(error => error)
    assert.equal(remoteErrorOf(child)?.code, 'virtual-desktop/owner-required')
    const launch = await scoped.virtualDesktop.launchChildApplication('C:\\Apps\\fixture.exe',randomUUID(),randomUUID(),1,new AbortController().signal).catch(error=>error)
    assert.equal(remoteErrorOf(launch)?.code,'virtual-desktop/owner-required')
    const service=ctx.virtualDesktop as any
    const originalAbort=service.applicationAbort
    const stop=await scoped.virtualDesktop.control('stop',new AbortController().signal).catch(error=>error)
    assert.equal(remoteErrorOf(stop)?.code,'virtual-desktop/owner-required')
    assert.equal(originalAbort.signal.aborted,false)
    const reset=await scoped.virtualDesktop.resetChildSession(randomUUID(),new AbortController().signal).catch(error=>error)
    assert.equal(remoteErrorOf(reset)?.code,'virtual-desktop/owner-required')
    assert.equal(originalAbort.signal.aborted,false)
  } finally { await ctx.fiber.dispose() }
})
test('experimental tasks are disabled before planner or input and reset refuses attended connection before stopping',async()=>{
  const ctx=await host()
  try{
    await ctx.plugin(plugin,{workerTimeoutMs:5000})
    const service=ctx.virtualDesktop as any
    await assert.rejects(service.startTask('{}',new AbortController().signal),/experimental/)
    const native=service.native,previous=native.status
    native.status=async()=>({backend:'windows-attended',status:'enabled'})
    const control=service.tasks.control;let stops=0
    service.tasks.control=async()=>{stops++;throw Error('must not stop attended')}
    try{await assert.rejects(service.resetChildSession(randomUUID(),new AbortController().signal),/本机桌面/);assert.equal(stops,0)}
    finally{native.status=previous;service.tasks.control=control}
  }finally{await ctx.fiber.dispose()}
})
