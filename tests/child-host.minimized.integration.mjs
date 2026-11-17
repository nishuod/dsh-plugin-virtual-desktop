// Opt-in DSH QA overlay. All actions target the copied child-session fixture.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import koffi from 'koffi'
import sharp from 'sharp'

export const name = 'desktop-child-session-minimized-qa'
export const inject = ['virtualDesktop']

const viewerTitle = 'Harness — Windows Child Session'
const fixtureTitle = 'DSH Desktop Test Fixture'
const wanted = 'Harness 最小化画中画 · 中文 ✓'

function readWindows() {
  const kernel = koffi.load('kernel32.dll')
  const user = koffi.load('user32.dll')
  const wts = koffi.load('wtsapi32.dll')
  const getSession = kernel.func('int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t* session)')
  const getChild = wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
  const querySession = wts.func('int __stdcall WTSQuerySessionInformationW(void* server, uint32_t session, int field, _Out_ void** data, _Out_ uint32_t* size)')
  const freeWts = wts.func('void __stdcall WTSFreeMemory(void* data)')
  const find = user.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, const str16 className, const str16 title)')
  const getWindowPid = user.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t window, _Out_ uint32_t* pid)')
  const isIconic = user.func('int __stdcall IsIconic(uintptr_t window)')
  const snapshot = kernel.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)')
  const processFirst = kernel.func('int __stdcall Process32FirstW(intptr_t snapshot, _Inout_ void* entry)')
  const processNext = kernel.func('int __stdcall Process32NextW(intptr_t snapshot, _Inout_ void* entry)')
  const close = kernel.func('int __stdcall CloseHandle(intptr_t handle)')
  const entryType = koffi.struct({
    size: 'uint32_t', usage: 'uint32_t', pid: 'uint32_t', heap: 'uintptr_t', module: 'uint32_t',
    threads: 'uint32_t', parentPid: 'uint32_t', priority: 'int32_t', flags: 'uint32_t', exe: koffi.array('uint16_t', 260),
  })

  function sessionOf(pid) {
    const session = [0]
    return getSession(pid, session) ? session[0] : null
  }

  function associatedChild() {
    const session = [0]
    return getChild(session) && session[0] !== 0xffffffff ? session[0] : null
  }

  function connectState(session) {
    const data = [null]
    const size = [0]
    if (!querySession(null, session, 8, data, size)) return null // WTSConnectState
    try { return data[0] && size[0] >= 4 ? koffi.decode(data[0], 'int32_t') : null }
    finally { if (data[0]) freeWts(data[0]) }
  }

  function processIdentity(pid) {
    const handle = snapshot(2, 0) // TH32CS_SNAPPROCESS
    assert.ok(handle && Number(handle) !== -1, 'Cannot query viewer process ownership')
    try {
      const entry = Buffer.alloc(koffi.sizeof(entryType))
      entry.writeUInt32LE(entry.length)
      for (let exists = processFirst(handle, entry); exists; exists = processNext(handle, entry)) {
        const process = koffi.decode(entry, entryType)
        if (process.pid === pid) {
          const exe = String.fromCharCode(...process.exe).split('\0', 1)[0]
          return { pid, parentPid: process.parentPid, exe }
        }
      }
      return null
    } finally {
      close(handle)
    }
  }

  function windowPid(window) {
    const pid = [0]
    return window && getWindowPid(window, pid) ? pid[0] : null
  }

  function viewerWindow(pid) {
    const matches = []
    let window = 0
    for (let i = 0; i < 32; i++) {
      window = find(0, window, null, viewerTitle)
      if (!window) break
      if (windowPid(window) === pid) matches.push(window)
    }
    assert.equal(matches.length, 1, 'Expected one viewer window owned by the verified broker')
    return matches[0]
  }

  return { associatedChild, connectState, isIconic, processIdentity, sessionOf, viewerWindow, windowPid }
}

function savedState(value) {
  return {
    pid: value.pid, clicks: value.clicks, wheels: value.wheels, text: value.text,
    scrollOffsetY: value.scrollOffsetY, scrollFirstRowY: value.scrollFirstRowY,
  }
}

export function apply(ctx) {
  const directory = process.env.DSH_VD_CHILD_QA
  if (!directory || !isAbsolute(directory)) throw new Error('The minimized QA overlay requires an isolated evidence directory')
  void run(ctx.virtualDesktop, directory).then(
    passed => { process.exit(passed ? 0 : 1) },
    error => { console.error(error); process.exit(1) },
  )
}

async function run(service, directory) {
  // Allow the operator to focus/minimize the preview and start the independent observer.
  // Individual actions/readbacks keep their short executor deadlines.
  const signal = AbortSignal.timeout(600000)
  const evidence = { schemaVersion: 1, passed: false, startedAt: Date.now(), steps: [], actions: [] }
  const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'))
  const write = (name, value) => writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
  const fixture = () => read('child-fixture/fixture-state.json')
  const captureWindow = () => service.capture('window', '', signal)
  let viewerPid
  let hwnd
  let target
  let stage = 'initialize'
  let connected = false
  let hostReady

  async function waitFor(callback, timeoutMs = 300000) {
    const deadline = Date.now() + timeoutMs
    do {
      signal.throwIfAborted()
      const value = await callback()
      if (value) return value
      await delay(100, undefined, { signal })
    } while (Date.now() < deadline)
    throw new Error(`Timed out during ${stage}`)
  }

  try {
    const idleSetting = process.env.DSH_VD_MINIMIZED_IDLE_MS ?? '0'
    const idleMs = Number(idleSetting)
    assert.ok(/^\d+$/.test(idleSetting) && Number.isSafeInteger(idleMs) && idleMs <= 25000,
      'DSH_VD_MINIMIZED_IDLE_MS must be an integer from 0 through 25000')
    evidence.minimizedIdleMs = idleMs

    const windows = readWindows()
    evidence.parentSessionId = windows.sessionOf(process.pid)
    assert.ok(evidence.parentSessionId > 0, 'The DSH Host must run in an interactive parent session')
    stage = 'connect'
    assert.equal((await service.desktopStatus(signal)).status, 'disabled')
    const state = await service.enableChildSession(signal)
    connected = true
    assert.equal(state.backend, 'windows-child-session')
    assert.equal(state.isolated, true)
    assert.equal(state.parentSessionId, evidence.parentSessionId)
    assert.ok(state.childSessionId > 0 && state.childSessionId !== evidence.parentSessionId)
    evidence.childSessionId = state.childSessionId
    assert.equal(windows.associatedChild(), evidence.childSessionId)

    stage = 'select fixture'
    const initial = await waitFor(() => fixture().catch(() => null))
    assert.equal(windows.sessionOf(initial.pid), evidence.childSessionId)
    assert.deepEqual(savedState(initial), { pid: initial.pid, clicks: 0, wheels: 0, text: '', scrollOffsetY: 0, scrollFirstRowY: 0 },
      'Expected a fresh fixture with scroll geometry. Rebuild the fixture before running.')
    evidence.initial = savedState(initial)
    const listed = await service.windows(signal)
    assert.ok(listed.length > 0 && listed.every(window => windows.sessionOf(window.pid) === evidence.childSessionId))
    const targets = listed.filter(window => window.pid === initial.pid && window.title === fixtureTitle)
    assert.equal(targets.length, 1, 'Expected only the copied child fixture to match')
    target = targets[0]
    const selected = await service.selectWindow(target.id, false, signal)
    assert.equal(selected.window?.id, target.id)
    await write('selected.json', { pid: target.pid, childSessionId: evidence.childSessionId, parentSessionId: evidence.parentSessionId, hostPid: process.pid })

    stage = 'identify minimized viewer'
    const start = await waitFor(() => read('input-start.json').catch(() => null))
    viewerPid = start.viewerPid ?? Number(process.env.DSH_VD_CHILD_QA_VIEWER_PID)
    assert.ok(Number.isSafeInteger(viewerPid) && viewerPid > 0 && viewerPid <= 0xffffffff, 'input-start.json must identify the viewer PID')
    assert.equal(windows.sessionOf(viewerPid), evidence.parentSessionId, 'Viewer is outside the parent session')
    const viewer = windows.processIdentity(viewerPid)
    assert.equal(viewer?.parentPid, process.pid, 'Viewer must be a direct child of this DSH Host')
    assert.equal(viewer.exe.toLowerCase(), 'childsessionhost.exe')
    hwnd = windows.viewerWindow(viewerPid)
    evidence.viewer = { ...viewer, hwnd: String(hwnd), title: viewerTitle }
    stage = 'verify host observer ready'
    const ready = await read('host-ready.json')
    assert.equal(ready.schemaVersion, 1)
    assert.equal(ready.hostSessionId, evidence.parentSessionId)
    assert.equal(ready.childSessionId, evidence.childSessionId)
    assert.ok(Number.isSafeInteger(ready.startedAt) && ready.startedAt <= Date.now())
    hostReady = ready

    function sample() {
      const owner = windows.windowPid(hwnd)
      return {
        at: Date.now(), viewerPid: owner, viewerSessionId: windows.sessionOf(viewerPid),
        isIconic: owner === viewerPid ? Boolean(windows.isIconic(hwnd)) : null,
        associatedChildSessionId: windows.associatedChild(), fixtureSessionId: windows.sessionOf(target.pid),
        childConnectState: windows.connectState(evidence.childSessionId),
      }
    }

    function requireMinimized(observation) {
      assert.equal(observation.viewerPid, viewerPid, 'The verified preview window disappeared or changed owner')
      assert.equal(observation.viewerSessionId, evidence.parentSessionId, 'The preview left the parent session')
      assert.equal(observation.isIconic, true, 'The verified preview was not minimized')
      assert.equal(observation.associatedChildSessionId, evidence.childSessionId, 'The child session disconnected or changed')
      assert.equal(observation.fixtureSessionId, evidence.childSessionId, 'The fixture left the verified child session')
      assert.equal(observation.childConnectState, 0, 'The verified child session is no longer WTSActive')
    }

    async function monitored(label, fn, type, screenshotLabel) {
      stage = label
      const entry = { label, startedAt: Date.now(), endedAt: null, before: sample(), after: null, passed: false }
      if (type) {
        entry.type = type
        entry.outcome = 'not-dispatched'
        evidence.actions.push(entry)
      }
      evidence.steps.push(entry)
      let result
      let failure
      try {
        requireMinimized(entry.before)
        result = await fn(entry)
      } catch (error) {
        failure = error
      } finally {
        entry.after = sample()
        entry.endedAt = Date.now()
      }
      try {
        requireMinimized(entry.after)
      } catch (error) {
        entry.afterError = error.message
        failure ??= error
      }
      if (result && screenshotLabel) {
        try { entry.screenshot = await saveFrame(result, screenshotLabel) }
        catch (error) { entry.screenshotError = error.message; failure ??= error }
      }
      if (failure) {
        entry.error = failure.message
        throw failure
      }
      entry.passed = true
      return result
    }

    async function saveFrame(frame, label) {
      assert.equal(frame?.source, 'window', 'Expected a window-only screenshot')
      assert.equal(frame.windowId, target.id, 'Screenshot belongs to a different window')
      assert.equal(frame.mimeType, 'image/jpeg')
      assert.ok(frame.width > 0 && frame.height > 0)
      const bytes = Buffer.from(frame.data, 'base64')
      assert.ok(bytes.length > 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9, 'Screenshot is not a complete JPEG')
      const file = `minimized-${label}.jpg`
      await writeFile(join(directory, file), bytes, { flag: 'wx' })
      return { file, id: frame.id, width: frame.width, height: frame.height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }

    async function capture(label) {
      return monitored(`capture ${label}`, async entry => {
        const result = await captureWindow()
        entry.frameId = result?.id ?? null
        return result
      }, undefined, label)
    }

    async function execute(label, type, control, fields, accept) {
      const frame = await capture(`${label}-before`)
      const before = await fixture()
      assert.equal(before.pid, target.pid, 'Saved state belongs to a different fixture')
      const x = Math.floor((before[`${control}X`] - target.x) * frame.width / target.width)
      const y = Math.floor((before[`${control}Y`] - target.y) * frame.height / target.height)
      assert.ok(x >= 0 && x < frame.width && y >= 0 && y < frame.height, 'Fixture control is outside the screenshot')
      const operation = {
        operationId: randomUUID(), frameId: frame.id, epoch: frame.epoch,
        delivery: 'background', action: { type, x, y, ...fields },
      }
      await monitored(`execute ${label}`, async entry => {
        entry.operationId = operation.operationId
        entry.frameBefore = frame.id
        entry.delivery = operation.delivery
        if (fields.direction) entry.direction = fields.direction
        entry.stateBefore = savedState(before)
        entry.outcome = 'unconfirmed'
        const receipt = await service.manualAction(JSON.stringify(operation), signal)
        entry.outcome = receipt.outcome
        entry.message = receipt.message
        entry.frameAfter = receipt.after?.id ?? null
        assert.equal(receipt.operationId, operation.operationId)
        assert.equal(receipt.outcome, 'delivered', receipt.message)
        assert.notEqual(receipt.after?.id, frame.id, 'Action did not return a new screenshot')
        return receipt.after
      }, type, `${label}-after`)
      const action = evidence.actions.at(-1)
      const readBack = await monitored(`read back ${label}`, () => waitFor(async () => {
        const value = await fixture().catch(() => null)
        if (!value) return null
        assert.equal(value.pid, target.pid, 'Saved state belongs to a different fixture')
        action.lastObservedState = savedState(value)
        return accept(before, value) ? value : null
      }, 4000))
      action.readBack = savedState(readBack)
      return { frame, before, readBack, action }
    }

    async function viewportPixels(frame, state) {
      const scaleX = frame.width / target.width
      const scaleY = frame.height / target.height
      // Keep the crop inside the row content and clear of the scroll bar and status label.
      const left = Math.ceil((state.scrollViewX + state.scrollViewWidth * 0.025 - target.x) * scaleX)
      const top = Math.ceil((state.scrollViewY + state.scrollViewHeight * 0.025 - target.y) * scaleY)
      const right = Math.floor((state.scrollViewX + state.scrollViewWidth * 0.65 - target.x) * scaleX)
      const bottom = Math.floor((state.scrollViewY + state.scrollViewHeight * 0.94 - target.y) * scaleY)
      assert.ok(left >= 0 && top >= 0 && right <= frame.width && bottom <= frame.height && right > left && bottom > top,
        'The scroll content crop is outside the screenshot')
      return sharp(Buffer.from(frame.data, 'base64')).extract({ left, top, width: right - left, height: bottom - top })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true })
    }

    async function verifyScroll(label, direction) {
      const sign = direction === 'down' ? 1 : -1
      const { frame, before, readBack, action } = await execute(label, 'scroll', 'scroll', { direction, amount: 3 }, (previous, current) =>
        sign * (current.scrollOffsetY - previous.scrollOffsetY) > 0 &&
        sign * (previous.scrollFirstRowY - current.scrollFirstRowY) > 0)
      const verified = await capture(`${label}-verified`)
      stage = `verify visible scroll ${label}`
      const [previous, current] = await Promise.all([viewportPixels(frame, before), viewportPixels(verified, readBack)])
      assert.deepEqual(current.info, previous.info, 'The scroll content crop dimensions changed')
      const { channels, width, height } = current.info
      assert.equal(channels, 3)
      let changedPixels = 0
      for (let i = 0; i < current.data.length; i += channels) {
        const difference = Math.abs(current.data[i] - previous.data[i]) +
          Math.abs(current.data[i + 1] - previous.data[i + 1]) +
          Math.abs(current.data[i + 2] - previous.data[i + 2])
        if (difference >= 20) changedPixels++
      }
      action.scrollProof = {
        offsetDelta: readBack.scrollOffsetY - before.scrollOffsetY,
        firstRowDelta: readBack.scrollFirstRowY - before.scrollFirstRowY,
        frameId: verified.id, changedPixels, pixels: width * height,
      }
      assert.ok(changedPixels >= Math.max(100, width * height * 0.005), 'The screenshot does not show a visible change inside the scroll rows')
    }

    async function waitWhileMinimized(label) {
      if (!idleMs) return
      await monitored(`minimized idle before ${label}`, async entry => {
        entry.idleMs = idleMs
        await delay(idleMs, undefined, { signal })
      })
    }

    await waitWhileMinimized('click and type')
    await execute('click', 'click', 'button', { button: 'left', count: 1 }, (before, after) => after.clicks === before.clicks + 1)
    await execute('type', 'type', 'text', { text: wanted }, (_before, after) => after.text === wanted)
    for (let round = 1; round <= 3; round++) {
      await waitWhileMinimized(`scroll round ${round}`)
      await verifyScroll(`scroll-${round}-down`, 'down')
      await verifyScroll(`scroll-${round}-up`, 'up')
    }
    await capture('final')
    evidence.saved = savedState(await fixture())
    assert.equal(evidence.saved.pid, target.pid)
    assert.equal(evidence.saved.clicks, 1)
    assert.equal(evidence.saved.text, wanted)
    assert.equal(evidence.saved.scrollOffsetY, evidence.actions.at(-1).readBack.scrollOffsetY)
    assert.equal(evidence.saved.scrollFirstRowY, evidence.actions.at(-1).readBack.scrollFirstRowY)
    await monitored('final connection', async () => {
      const final = await service.desktopStatus(signal)
      evidence.finalConnection = { status: final.status, backend: final.backend, isolated: final.isolated, childSessionId: final.childSessionId }
      assert.equal(final.status, 'enabled', 'The child connection did not remain enabled')
      assert.equal(final.backend, 'windows-child-session')
      assert.equal(final.isolated, true)
      assert.equal(final.childSessionId, evidence.childSessionId)
      assert.equal(final.window?.id, target.id)
    })
    await write('input-verified.json', evidence.saved)
    evidence.passed = true
  } catch (error) {
    evidence.stage = stage
    evidence.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (hostReady) {
      try {
        await writeFile(join(directory, 'host-stop.json'), '{}\n', { flag: 'wx' }).catch(error => {
          if (error.code !== 'EEXIST') throw error
        })
        const deadline = AbortSignal.timeout(10000)
        while (!evidence.hostIsolation) {
          deadline.throwIfAborted()
          evidence.hostIsolation = await read('host-observation.json').catch(() => null)
          if (!evidence.hostIsolation) await delay(100, undefined, { signal: deadline })
        }
        const observation = evidence.hostIsolation
        assert.equal(observation.schemaVersion, 1)
        assert.equal(observation.hostSessionId, hostReady.hostSessionId)
        assert.equal(observation.childSessionId, hostReady.childSessionId)
        assert.equal(observation.startedAt, hostReady.startedAt)
        assert.equal(observation.passed, true, 'The independent host isolation observer failed')
        assert.equal(observation.fixtureUnchanged, true)
        assert.equal(observation.cursorChanges, 0)
        assert.equal(observation.foregroundChanges, 0)
        assert.equal(observation.fixtureWrites, 0)
        if (evidence.steps.length) {
          assert.ok(observation.startedAt <= evidence.steps[0].startedAt && observation.endedAt >= evidence.steps.at(-1).endedAt,
            'The independent host observation did not cover the minimized steps')
        }
      } catch (error) {
        evidence.hostIsolationError = error instanceof Error ? error.message : String(error)
        evidence.passed = false
      }
    }
    if (connected) {
      try {
        const stopped = await service.control('stop', AbortSignal.timeout(18000))
        assert.equal(stopped.status, 'stopped', 'The child session did not stop cleanly')
        evidence.cleanup = 'stopped'
      } catch (error) {
        evidence.cleanup = error instanceof Error ? error.message : String(error)
        evidence.passed = false
      }
    }
    evidence.endedAt = Date.now()
    await write('harness-minimized-qa.json', evidence)
  }
  return evidence.passed
}
