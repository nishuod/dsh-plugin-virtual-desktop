// Opt-in test-only plugin for a dedicated DSH QA profile. Never install in Desktop.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'desktop-task-fixture-probe'
export const inject = ['virtualDesktop', 'llm', 'attachments', 'sessions']

const fixtureFile = new URL('./fixtures/fixture-state.json', import.meta.url)
const state = async () => JSON.parse(await readFile(fixtureFile, 'utf8'))
const title = 'DSH Desktop Test Fixture'
const editLabel = '测试文本输入框'
const signal = AbortSignal.timeout(140000)

export function apply(ctx) {
  const mode = process.env.DSH_VD_FIXTURE_MODE
  const output = process.env.DSH_VD_FIXTURE_OUTPUT
  if (!['fixture-adapter', 'deepseek'].includes(mode) || !output) {
    throw new Error('The test probe needs an explicit mode and evidence path')
  }
  void (async () => {
    const evidence = { mode, passed: false, inputApprovals: [], verificationApprovals: 0, imageRequests: 0 }
    try {
      await delay(900, undefined, { signal })
      await run(ctx, evidence)
      evidence.passed = true
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : 'fixture test failed'
      evidence.task = await ctx.virtualDesktop.taskStatus(signal).catch(() => null)
    } finally {
      await ctx.virtualDesktop.control('stop', AbortSignal.timeout(25000)).catch(() => {})
      await writeFile(output, JSON.stringify(evidence, null, 2))
      // This profile and its process exist only for the probe.
      process.exit(evidence.passed ? 0 : 1)
    }
  })()
}

async function run(ctx, evidence) {
  const service = ctx.virtualDesktop
  const initial = await state()
  assert.equal(initial.text, '', 'Open a fresh test fixture')
  const wanted = `桌面闭环 ${randomUUID().slice(0, 6)}`
  evidence.expected = wanted
  evidence.initialClicks = initial.clicks
  let window
  if (evidence.mode === 'fixture-adapter') {
    const provider = 'desktop-fixture-adapter'
    const model = 'fixture-vision'
    class FixtureAdapter extends LlmAdapter {
      async listModels() { return [{ provider, id: model, name: model, inputModalities: ['text', 'image'] }] }
      async resolveModel() { return (await this.listModels())[0] }
      async *stream(options) {
        assert.equal(options.tools.length, 1)
        assert.equal(options.tools[0].name, 'propose_desktop_step')
        const parts = options.messages[0].content
        const image = parts.find(part => part.type === 'image')
        assert.ok(image)
        const { data } = await ctx.attachments.readImage(image.attachment, options.signal)
        assert.ok(data.length > 100)
        evidence.imageRequests++
        const current = await state()
        const memory = JSON.parse(parts.find(part => part.type === 'text').text)
        const point = (x, y) => ({
          x: Math.round((x - window.x) * 1000 / window.width),
          y: Math.round((y - window.y) * 1000 / window.height),
        })
        let decision
        if (current.clicks === initial.clicks) {
          decision = { kind: 'act', explanation: '在测试窗口增加计数', action: {
            type: 'click', ...point(current.buttonX, current.buttonY),
          } }
        } else if (current.text !== wanted) {
          assert.equal(memory.recent.length, 1)
          decision = { kind: 'act', explanation: '填写测试文本', action: {
            type: 'type', ...point(current.textX, current.textY), text: wanted,
          } }
        } else {
          assert.equal(memory.recent.length, 2)
          decision = { kind: 'finished', explanation: '测试输入框和计数已更新' }
        }
        yield {
          type: 'block-end', index: 0, block: {
            type: 'tool-call', id: ToolCallId(randomUUID()), name: 'propose_desktop_step',
            arguments: JSON.stringify({ decision }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter([provider], new FixtureAdapter())
  }
  const routes = await service.taskRoutes(signal)
  evidence.routes = routes.map(({ provider, model }) => ({ provider, model }))
  const route = evidence.mode === 'deepseek'
    ? routes.find(route => /deepseek/i.test(route.provider) && /flash/i.test(route.model))
    : routes.find(route => route.provider === 'desktop-fixture-adapter')
  assert.ok(route, 'The QA profile did not expose the requested vision route')
  evidence.route = { provider: route.provider, model: route.model }

  await service.enableLocal(signal)
  const windows = (await service.windows(signal)).filter(item =>
    item.title === title && item.pid === initial.pid && item.app.toLowerCase().includes('dsh-desktop-fixture'))
  assert.equal(windows.length, 1)
  window = windows[0]
  const runtime = await service.selectWindow(window.id, true, signal)
  const started = await service.startTask(JSON.stringify({
    goal: `在当前测试窗口单击一次「增加计数」，然后在「${editLabel}」输入 ${wanted}。完成后提出完成。`,
    acceptance: `计数是 ${initial.clicks + 1} 且测试文本完整等于 ${wanted}`,
    windowId: window.id, epoch: runtime.epoch, route: evidence.route,
    maxSteps: 8, timeoutSeconds: 120, delivery: 'foreground',
  }), signal)

  let editFocusClicks = 0
  for (;;) {
    await delay(100, undefined, { signal })
    const task = await service.taskStatus(signal)
    assert.equal(task.id, started.id)
    if (!task.active) {
      evidence.task = task
      assert.equal(task.status, 'completed', task.logs.at(-1)?.message)
      break
    }
    const review = task.review
    if (!review) continue
    const current = await state()
    const frame = await service.taskFrame(task.id, review.frameId, signal)
    assert.equal(current.pid, initial.pid)
    assert.equal(frame.windowId, window.id)
    if (review.kind === 'verification') {
      const done = current.clicks === initial.clicks + 1 && current.text === wanted
      if (done) evidence.verificationApprovals++
      await service.answerTask(task.id, review.id, done ? 'approve' : 'reject', signal)
      continue
    }
    const action = JSON.parse(review.detail)
    const x = window.x + action.x * window.width / frame.width
    const y = window.y + action.y * window.height / frame.height
    const inEdit = Math.abs(x - current.textX) < 290 && Math.abs(y - current.textY) < 40
    const leftClick = action.type === 'click' && action.button === 'left' && action.count === 1
    const onCounter = leftClick && current.clicks === initial.clicks
      && Math.abs(x - current.buttonX) < 85 && Math.abs(y - current.buttonY) < 30
    const focusEdit = leftClick && inEdit && current.clicks === initial.clicks + 1
      && current.text === '' && editFocusClicks === 0
    const fillEdit = action.type === 'type' && action.text === wanted && current.clicks === initial.clicks + 1
      && current.text === '' && inEdit
    const approved = onCounter || focusEdit || fillEdit
    assert.ok(approved, `Fixture rejected proposed ${action.type} at (${action.x}, ${action.y})`)
    if (focusEdit) editFocusClicks++
    evidence.inputApprovals.push(onCounter ? 'click-counter' : focusEdit ? 'focus-edit' : 'type')
    await service.answerTask(task.id, review.id, 'approve', signal)
  }
  const final = await state()
  assert.equal(final.clicks, initial.clicks + 1)
  assert.equal(final.text, wanted)
  assert.equal(evidence.inputApprovals[0], 'click-counter')
  assert.ok(evidence.inputApprovals.includes('type'))
  assert.equal(evidence.verificationApprovals, 1)
  evidence.final = { clicks: final.clicks, text: final.text }
  const readback = await service.capture('window', '', signal)
  evidence.finalFrame = { width: readback.width, height: readback.height, id: readback.id }
}
