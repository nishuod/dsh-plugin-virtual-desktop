// Windows x64 acceptance. Run npm run build before using this owned-session probe.
// node tests/restore-window.live.mjs --allow-owned-vmware
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const optIn = '--allow-owned-vmware'
const workerFlag = '--probe-worker'
if (!process.argv.includes(optIn)) throw new Error('Pass --allow-owned-vmware to open, minimize and restore one test-owned VMware window')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This live probe requires Windows x64')

const worker = process.argv.indexOf(workerFlag)
if (worker < 0) {
  const artifacts = resolve('artifacts')
  await mkdir(artifacts, { recursive: true })
  const snapshot = await mkdtemp(join(artifacts, 'n1-live-'))
  await cp('lib', join(snapshot, 'lib'), { recursive: true, errorOnExist: true })
  // Probe the same Host, bridge and worker bytes even if a later local build starts.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), optIn, workerFlag, snapshot], {
    stdio: 'inherit', windowsHide: true,
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
} else {
  await probe(process.argv[worker + 1])
}

function rect({ x, y, width, height }) {
  return { x, y, width, height }
}

// The SDK clips its bitmap one pixel inside the capture rectangle. A GetWindowRect
// reply can additionally include invisible resize borders, so only compare bounds
// after transforming the JPEG region back into capture-relative raw pixels.
function verifyImageGeometry(frame, outer) {
  const scale = frame.scale
  const area = frame.accessibility?.visualCandidates?.clientArea
  assert.ok(scale, 'Missing screenshot scale')
  assert.ok(area, 'Missing screenshot client area')
  assert.equal(scale.width, frame.width)
  assert.equal(scale.height, frame.height)
  assert.ok(area.x >= 0 && area.y >= 0 && area.width > 0 && area.height > 0)
  assert.ok(area.x + area.width <= frame.width && area.y + area.height <= frame.height)
  const capture = { width: scale.rawWidth + 2, height: scale.rawHeight + 2 }
  const resizeBorderDelta = { width: outer.width - capture.width, height: outer.height - capture.height }
  assert.ok(Math.abs(resizeBorderDelta.width) <= 32 && Math.abs(resizeBorderDelta.height) <= 32,
    `Screenshot extent no longer matches the restored window, except its resize borders: ${JSON.stringify({ capture, outer })}`)
  const relativeClient = {
    x: 1 + area.x * scale.rawWidth / scale.width,
    y: 1 + area.y * scale.rawHeight / scale.height,
    width: area.width * scale.rawWidth / scale.width,
    height: area.height * scale.rawHeight / scale.height,
  }
  assert.ok(relativeClient.x + relativeClient.width <= capture.width + 0.01)
  assert.ok(relativeClient.y + relativeClient.height <= capture.height + 0.01)
  assert.ok(relativeClient.width <= outer.width + 2 && relativeClient.height <= outer.height + 2)
  return { frameId: frame.id, scale, capture, clientArea: area, relativeClient, resizeBorderDelta, notice: frame.notice }
}

async function probe(snapshot) {
  const { default: koffi } = await import('koffi')
  const { Context } = await import('@deepseek-ai/cordis')
  const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const NativeToolExecutor = await import('@deepseek-ai/dsh-tool-executor-native')
  const { default: ComputerUseRegistry } = await import('@deepseek-ai/dsh-computer-use')
  const { decodeChildAssociation } = await import('../scripts/eval-contract.mjs')
  const library = join(snapshot, 'lib')
  const plugin = await import(pathToFileURL(join(library, 'index.js')).href)
  const wts = koffi.load('wtsapi32.dll')
  const kernel = koffi.load('kernel32.dll')
  const query = wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
  const readError = kernel.func('uint32_t __stdcall GetLastError()')
  const clearError = kernel.func('void __stdcall SetLastError(uint32_t error)')
  function associated() {
    const id = [0xffffffff]
    clearError(0)
    const ok = query(id)
    return decodeChildAssociation(ok, id[0], readError())
  }

  const ctx = new Context()
  const signal = () => AbortSignal.timeout(90_000)
  const agent = { session: { requestHeader: () => undefined }, options: { provider: 'test', model: 'vision' } }
  let approvalRequests = 0
  const report = { startedAt: new Date().toISOString(), passed: false, iterations: [] }
  let controller
  let stage = 'verify an unused child association'
  async function run(name, args = {}, isError = false) {
    const { results } = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) }],
      signal: signal(), agent,
    })
    const result = results[0].result
    const block = result.content.find(item => item.type === 'text')
    assert.equal(result.isError, isError, block?.text)
    return result.structuredContent ?? JSON.parse(block.text)
  }
  try {
    assert.equal(associated(), null, 'Existing child association: aborting without claiming or changing it')
    report.snapshot = {}
    for (const name of ['index.js', 'child-session-bridge.js', 'native-worker.js', 'child-session-host/ChildSessionHost.exe', 'child-session-host/ChildSessionHost.dll']) {
      report.snapshot[name] = createHash('sha256').update(await readFile(join(library, name))).digest('hex')
    }
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(ComputerUseRegistry)
    // Single approval for each explicitly opted-in fixture call. No model traffic.
    ctx.provide('approval', { request: async () => { approvalRequests++; return 'allowed-once' } })
    ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['image'] }) })
    await ctx.plugin(plugin, {})
    controller = ctx.virtualDesktop
    stage = 'open VMware Workstation in the probe-owned child session'
    assert.equal(associated(), null, 'A different child association was established during startup')
    const opened = await run('desktop_open_application', { appId: 'vmware-workstation' })
    assert.equal(opened.status, 'ready', opened.message)
    const { id: windowId, pid } = opened.window
    const initial = await run('desktop_get_task_status')
    const { connectionId, childSessionId, parentSessionId } = initial
    assert.ok(connectionId && childSessionId)
    assert.equal(associated(), childSessionId)
    assert.notEqual(childSessionId, parentSessionId)
    report.scope = { windowId, pid, connectionId, childSessionId, parentSessionId }
    function verifyScope(value) {
      assert.equal(value.backend, 'windows-child-session')
      assert.equal(value.isolated, true)
      assert.equal(value.foregroundAllowed, false)
      assert.equal(value.connectionId, connectionId)
      assert.equal(value.childSessionId, childSessionId)
      assert.equal(value.window?.id, windowId)
      assert.equal(value.window?.pid, pid)
    }
    verifyScope(initial)
    let frame = await run('desktop_get_screenshot')
    for (let iteration = 1; iteration <= 10; iteration++) {
      stage = `minimize ${iteration}`
      assert.equal(frame.windowId, windowId)
      assert.equal(frame.privacy?.status, 'clear')
      const targets = frame.accessibility?.suggestedTargets?.filter(target =>
        target.basis === 'uia-bounds' && target.controlType === 'Button' && /^(最小化|Minimi[sz]e)$/iu.test(target.name)) ?? []
      assert.equal(targets.length, 1, 'The latest frame must identify one UIA Minimize target')
      const args = { frameId: frame.id, epoch: frame.epoch, target: { id: targets[0].id } }
      const click = await run('desktop_click_target', { operationId: randomUUID(), ...args })
      assert.equal(click.outcome, 'delivered', click.message)
      assert.equal(click.hitTest?.class, 'HTMINBUTTON')
      assert.equal(click.hitTest.code, 8)
      assert.deepEqual(click.delivery, { kind: 'WM_SYSCOMMAND', command: 'SC_MINIMIZE' })
      assert.equal(click.postAction?.reason, 'minimized')
      if (iteration > 1) {
        const previous = report.iterations.at(-1)
        const { x, y } = previous.restored.rect
        const origin = click.hitTest.windowOrigin
        const border = { x: x - origin.x, y: y - origin.y }
        assert.ok(border.x >= 0 && border.x <= 32 && border.y >= 0 && border.y <= 32,
          `The next native hit test saw a different physical origin beyond the resize border: ${JSON.stringify(border)}`)
        previous.nextHitTest = { origin, border }
      }
      const step = { iteration, click: { frameId: frame.id, epoch: frame.epoch, hitTest: click.hitTest, delivery: click.delivery, postAction: click.postAction } }
      report.iterations.push(step)
      stage = `restore ${iteration}`
      const minimized = await run('desktop_get_task_status')
      verifyScope(minimized)
      const started = performance.now()
      const restored = await run('desktop_restore_window', { windowId, pid, connectionId, epoch: minimized.epoch })
      step.restored = { state: restored.state, verified: restored.verified, elapsedMs: performance.now() - started,
        rect: restored.window ? rect(restored.window) : undefined, epoch: restored.epoch }
      assert.equal(restored.state, 'restored', JSON.stringify(restored))
      assert.equal(restored.verified, true)
      assert.equal(restored.nextTool, 'desktop_get_screenshot')
      verifyScope(restored)
      const outer = rect(restored.window)
      assert.ok(outer.x > -30000 && outer.y > -30000, 'A minimized sentinel escaped in the restored window')
      assert.ok(outer.width > 0 && outer.height > 0)

      stage = `reject the pre-restore frame and observe ${iteration}`
      const old = await run('desktop_click_target', { operationId: randomUUID(), ...args }, true)
      assert.match(old.error, /输入许可未开启|截图已过期|截图许可|截图.*(?:失效|替换|使用)|帧.*(?:过期|失效)/u)
      step.oldFrameRejected = true
      frame = await run('desktop_get_screenshot')
      assert.equal(frame.windowId, windowId)
      assert.equal(frame.epoch, restored.epoch)
      assert.notEqual(frame.id, args.frameId)
      const stale = await run('desktop_click_target', { operationId: randomUUID(), ...args }, true)
      assert.match(stale.error, /截图已过期|截图.*(?:失效|替换|使用)|帧.*(?:过期|失效)/u)
      step.observation = verifyImageGeometry(frame, outer)
      const observed = await run('desktop_get_task_status')
      verifyScope(observed)
      assert.equal(observed.epoch, frame.epoch)
      assert.deepEqual(rect(observed.window), outer, 'Window geometry changed between restoration and screenshot')
      step.nextStatusRectMatches = true
    }
    report.approvalRequests = approvalRequests
    report.passed = true
  } catch (error) {
    report.error = { stage, message: String(error?.message ?? error) }
    process.exitCode = 1
  } finally {
    try {
      if (controller) {
        const reset = await controller.resetChildSession(randomUUID(), signal())
        report.cleanup = { status: reset.status, association: associated() }
        assert.equal(report.cleanup.status, 'stopped')
        assert.equal(report.cleanup.association, null)
      }
    } catch (error) {
      report.cleanup = { ...report.cleanup, error: String(error?.message ?? error) }
      report.passed = false
      process.exitCode = 1
    }
    await ctx.fiber.dispose()
    report.completedAt = new Date().toISOString()
    const directory = resolve('evidence/n1')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'live.json')
    await writeFile(path, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ path, passed: report.passed, iterations: report.iterations.length, error: report.error, cleanup: report.cleanup }))
  }
}
