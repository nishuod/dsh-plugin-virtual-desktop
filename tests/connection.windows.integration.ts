// Opt-in. Run with `node --import tsx tests/connection.windows.integration.ts` and a fresh QA directory.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { access, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { AttachmentId, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolRuntime, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { TypertRegistry, type TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import koffi from 'koffi'
import sharp from 'sharp'
import { TYPERT as contribution } from '../lib/typert.host.js'
import remote from '../lib/typert.remote-client.js'
import type { DesktopFrame, DesktopRuntimeState, DesktopWindow } from '../src/native-contract.ts'
import { prepareVmCommandQa, runVmCommandQa } from './vm-command.qa.ts'

const openTool = 'desktop_open_child_session'
const listTool = 'desktop_get_windows'
const selectTool = 'desktop_select_window'
const screenshotTool = 'desktop_get_screenshot'
const diagnosticsTool = 'desktop_get_diagnostics'
const statusTool = 'desktop_get_task_status'
const stopTool = 'desktop_stop_task'
const fixtureTitle = 'DSH Desktop Test Fixture'
const viewerTitle = 'Harness — Windows Child Session'

type FixtureState = { pid: number; clicks: number; wheels: number; text: string; buttonX:number; buttonY:number; textX:number; textY:number; scrollX:number; scrollY:number; scrollOffsetY:number }
type Diagnostic = {
  diagnosticChannel: { backend: string }; desktop: DesktopRuntimeState; nextTool: string | null
  childStartPermission: 'ask' | 'session-grant' | 'blocked'
}

function windowsIdentity() {
  const kernel = koffi.load('kernel32.dll')
  const user = koffi.load('user32.dll')
  const wts = koffi.load('wtsapi32.dll')
  const getSession = kernel.func('int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t* session)')
  const getChild = wts.func('int __stdcall WTSGetChildSessionId(_Out_ uint32_t* session)')
  const querySession = wts.func('int __stdcall WTSQuerySessionInformationW(void* server, uint32_t session, int field, _Out_ void** data, _Out_ uint32_t* size)')
  const freeSession = wts.func('void __stdcall WTSFreeMemory(void* data)')
  const openProcess = kernel.func('void* __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)')
  const closeProcess = kernel.func('int __stdcall CloseHandle(void* handle)')
  const imageName = kernel.func('int __stdcall QueryFullProcessImageNameW(void* handle, uint32_t flags, _Out_ void* name, _Inout_ uint32_t* length)')
  const snapshot = kernel.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)')
  const processFirst = kernel.func('int __stdcall Process32FirstW(intptr_t snapshot, _Inout_ void* entry)')
  const processNext = kernel.func('int __stdcall Process32NextW(intptr_t snapshot, _Inout_ void* entry)')
  const closeSnapshot = kernel.func('int __stdcall CloseHandle(intptr_t handle)')
  const entryType = koffi.struct({
    size: 'uint32_t', usage: 'uint32_t', pid: 'uint32_t', heap: 'uintptr_t', module: 'uint32_t',
    threads: 'uint32_t', parentPid: 'uint32_t', priority: 'int32_t', flags: 'uint32_t', exe: koffi.array('uint16_t', 260),
  })
  const clientDisplayType = koffi.struct({ width: 'uint32_t', height: 'uint32_t', colorDepth: 'uint32_t' })
  const findWindow = user.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, const str16 className, const str16 title)')
  const getWindowPid = user.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t window, _Out_ uint32_t* pid)')
  const foreground=user.func('uintptr_t __stdcall GetForegroundWindow()')
  const cursor=user.func('int __stdcall GetCursorPos(_Out_ int32_t* point)')
  const isIconic = user.func('int __stdcall IsIconic(uintptr_t window)')
  type Hwnd = number | bigint

  function windowPid(hwnd: Hwnd): number | null {
    const pid = [0]
    return hwnd && getWindowPid(hwnd, pid) ? pid[0] : null
  }

  function viewerChildren(hostPid: number): Set<number> {
    const handle = snapshot(2, 0) // TH32CS_SNAPPROCESS
    assert.ok(handle && Number(handle) !== -1, 'Cannot verify the viewer process lineage')
    try {
      const children = new Set<number>()
      const entry = Buffer.alloc(koffi.sizeof(entryType))
      entry.writeUInt32LE(entry.length)
      for (let found = processFirst(handle, entry); found; found = processNext(handle, entry)) {
        const record = koffi.decode(entry, entryType)
        if (record.parentPid === hostPid && String.fromCharCode(...record.exe).split('\0', 1)[0].toLowerCase() === 'childsessionhost.exe') {
          children.add(record.pid)
        }
      }
      return children
    } finally { closeSnapshot(handle) }
  }

  return {
    hostInput(){const point=[0,0];assert.ok(cursor(point));return {foreground:String(foreground()),point}},
    session(pid: number): number | null {
      const output = [0]
      return getSession(pid, output) ? output[0] : null
    },
    child(): number | null {
      const output = [0]
      return getChild(output) && output[0] !== 0xffffffff ? output[0] : null
    },
    connectState(session: number): number | null {
      const data = [null]
      const size = [0]
      if (!querySession(null, session, 8, data, size)) return null // WTSConnectState
      try { return data[0] && size[0] >= 4 ? koffi.decode(data[0], 'int32_t') : null }
      finally { if (data[0]) freeSession(data[0]) }
    },
    clientDisplay(session: number): { width: number; height: number } | null {
      const data = [null]
      const size = [0]
      if (!querySession(null, session, 15, data, size)) return null // WTSClientDisplay
      try {
        if (!data[0] || size[0] < koffi.sizeof(clientDisplayType)) return null
        const { width, height } = koffi.decode(data[0], clientDisplayType)
        return width && height ? { width, height } : null
      } finally {
        if (data[0]) freeSession(data[0])
      }
    },
    viewer(hostPid: number) {
      const children = viewerChildren(hostPid)
      const matches: { viewerPid: number; hwnd: Hwnd }[] = []
      for (let hwnd = findWindow(0, 0, null, viewerTitle) as Hwnd; hwnd; hwnd = findWindow(0, hwnd, null, viewerTitle) as Hwnd) {
        const pid = windowPid(hwnd)
        if (pid !== null && children.has(pid)) matches.push({ viewerPid: pid, hwnd })
      }
      assert.equal(matches.length, 1, 'Expected exactly one viewer window owned by this QA Host')
      return matches[0]
    },
    viewerIsMinimized(viewer: { viewerPid: number; hwnd: Hwnd }): boolean {
      assert.equal(windowPid(viewer.hwnd), viewer.viewerPid, 'The verified QA viewer disappeared or changed owner')
      return Boolean(isIconic(viewer.hwnd))
    },
    image(pid: number): string {
      const handle = openProcess(0x1000, 0, pid) // PROCESS_QUERY_LIMITED_INFORMATION
      assert.ok(handle, 'Cannot open the owned fixture process')
      try {
        const name = Buffer.alloc(65536)
        const length = [name.length / 2]
        assert.ok(imageName(handle, 0, name, length), 'Cannot verify the owned fixture executable')
        return name.toString('utf16le', 0, length[0] * 2)
      } finally {
        closeProcess(handle)
      }
    },
  }
}

function requireConnectionId(state: DesktopRuntimeState): string {
  assert.ok(state.connectionId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(state.connectionId),
    'Expected a fresh Host connection UUID')
  return state.connectionId
}

function requireDiscovery(state: DesktopRuntimeState, count: number) {
  const report = state.windowDiscovery
  assert.ok(report, 'The Host did not provide discovery diagnostics after listing windows')
  assert.ok(report.rawTopLevel !== null && report.rawTopLevel > 0, 'EnumWindows did not report any child desktop surfaces')
  assert.ok(report.sdkCandidates >= report.workerEligible && report.workerEligible >= count)
  assert.equal(report.sessionEligible, count)
  assert.ok(Number.isSafeInteger(report.sampledAt) && report.sampledAt > 0)
  assert.ok(Number.isSafeInteger(report.filtered.systemSurface) && report.filtered.systemSurface >= 0)
  assert.ok(Object.values(report.filtered).every(value => Number.isSafeInteger(value) && value >= 0))
  return report
}

async function main() {
  const directory = process.env.DSH_VD_CONNECTION_QA
  assert.ok(process.platform === 'win32' && directory && isAbsolute(directory), 'Set DSH_VD_CONNECTION_QA to a fresh absolute Windows QA directory')
  const vmCommandMode = process.env.DSH_VD_VM_COMMAND_QA === '1'
  const shellOnly = process.env.DSH_VD_CONNECTION_QA_SHELL_ONLY === '1' || vmCommandMode
  const applicationPath = process.env.DSH_VD_CONNECTION_QA_APPLICATION
  const launchFixture = process.env.DSH_VD_CONNECTION_QA_LAUNCH_FIXTURE === '1'
  const defects = process.env.DSH_VD_DEFECT_QA === '1'
  const captionWidth = Number(process.env.DSH_VD_CAPTION_QA || 0)
  const verifyMinimized = process.env.DSH_VD_CONNECTION_QA_VERIFY_MINIMIZED === '1'
  const verifyDisplay = process.env.DSH_VD_CONNECTION_QA_DISPLAY === '1'
  assert.ok(!shellOnly || !verifyMinimized, 'Choose either shell-only or minimized fixture QA')
  const fixtureDir = join(directory, 'child-fixture')
  const expectedImage = shellOnly ? undefined : await realpath(join(fixtureDir, 'dsh-desktop-fixture.exe'))
  const fixturePath = join(fixtureDir, 'fixture-state.json')
  const reportPath = join(directory, 'connection-qa.json')
  const ctx = new Context()
  const signal = AbortSignal.timeout(verifyMinimized ? 400000 : vmCommandMode ? 300000 : 155000)
  function ownerPeer(id: string): PeerScope {
    const peerContext = new Context()
    return {
      id: id as PeerScope['id'], ctx: peerContext, principal: { kind: 'owner' }, signal,
      interactions: 'none', dispose: () => peerContext.fiber.dispose(),
    }
  }
  let owner = ownerPeer('connection-qa-owner')
  const evidence: Record<string, unknown> = {
    schemaVersion: 1, passed: false, startedAt: Date.now(), mode: vmCommandMode ? 'vm-command' : shellOnly ? 'shell-only' : verifyMinimized ? 'minimized-fixture' : 'fixture',
  }
  const approvals: { toolName: string; callId?: string; reason?: string; allowed: boolean }[] = []
  evidence.approvals = approvals
  const watchdog = setTimeout(() => {
    evidence.error = 'Hard test deadline exceeded'
    evidence.passed = false
    evidence.endedAt = Date.now()
    try { writeFileSync(reportPath, JSON.stringify(evidence, null, 2), { flag: 'wx' }) }
    finally { process.exit(1) }
  }, verifyMinimized ? 425000 : vmCommandMode ? 380000 : 180000)
  let stage = 'initialize'
  let windows: ReturnType<typeof windowsIdentity> | undefined
  let connected = false
  let rejectImages = false
  const agent = { session: { requestHeader: () => undefined }, options: { provider: 'qa', model: 'fixture' } } as unknown as NonNullable<ToolExecution['agent']>
  let approvalPolicy: 'ask' | 'never' = 'never'
  let permissionPreset: 'workspace-write' | 'danger-full-access' = 'workspace-write'
  let sandboxMode: 'workspace-write' | 'danger-full-access' = 'workspace-write'
  const policyReads = { approval: 0, preset: 0, sandbox: 0 }
  evidence.policyReads = policyReads

  async function invoke(name: string, args: Record<string, unknown> = {}, requestSignal = signal) {
    const id = ToolCallId(randomUUID())
    const { results } = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }], agent, signal: requestSignal,
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].callId, id)
    const { result } = results[0]
    const content = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    return { isError: result.isError, content, raw:result }
  }

  async function execute<T>(name: string, args: Record<string, unknown> = {}, requestSignal = signal): Promise<T> {
    const result = await invoke(name, args, requestSignal)
    assert.equal(result.isError, false, `${name}: ${result.content}`)
    return JSON.parse(result.content) as T
  }

  async function ownerRemote(method: 'windows' | 'selectWindow' | 'desktopStatus' | 'capture', args: Record<string, unknown> = {}) {
    return await ctx.typertGateway.invoke({ namespace: 'virtualDesktop', method, args, peer: owner })
  }

  async function readFixture(): Promise<FixtureState | null> {
    try {
      return JSON.parse(await readFile(fixturePath, 'utf8')) as FixtureState
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  try {
    windows = windowsIdentity()
    const parentSessionId = windows.session(process.pid)
    assert.ok(parentSessionId && parentSessionId > 0)
    evidence.parentSessionId = parentSessionId
    assert.equal(windows.child(), null, 'An unrelated child session is already present')
    assert.equal(await readFixture(), null, 'Choose a fresh fixture directory without prior state')
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(ComputerUseRegistry)
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(contribution as TypertContribution)
    ctx.provide('remoteAccess', { decide: async () => ({ allowed: false }) })
    await ctx.plugin(Gateway, {})
    ctx.provide('approval', {
      config: { policy: 'ask' },
      overrideOf(session: typeof agent.session) {
        assert.equal(session, agent.session)
        policyReads.approval++
        return approvalPolicy
      },
      async request(request: ApprovalRequest) {
        assert.equal(request.agent, agent)
        request.signal?.throwIfAborted()
        const allowed = approvalPolicy === 'ask' && request.toolName === selectTool
        approvals.push({ toolName: request.toolName, callId: request.callId, reason: request.reason, allowed })
        return allowed ? 'allowed-once' : 'rejected'
      },
    } as unknown as Context['approval'])
    ctx.provide('permissionPresets', {
      current(session: typeof agent.session) {
        assert.equal(session, agent.session)
        policyReads.preset++
        return permissionPreset
      },
    })
    ctx.provide('sandboxPolicy', {
      resolve({ session }: { session: typeof agent.session }) {
        assert.equal(session, agent.session)
        policyReads.sandbox++
        return { mode: sandboxMode }
      },
    })
    ctx.provide('llm',{resolveModelInfo:async()=>({inputModalities:['image']})} as unknown as Context['llm'])
    const saveImage=async(input:SaveImageAttachment)=>{
      if(rejectImages)throw Object.assign(new Error('QA durable store quota exceeded'),{code:'EDQUOT'})
      const meta=await sharp(input.data).metadata()
      return {attachmentId:AttachmentId(createHash('sha256').update(input.data).digest('hex')),mediaType:input.mediaType,width:meta.width!,height:meta.height!,bytes:input.data.length}
    }
    ctx.provide('attachments',{saveImage,saveImages:async(inputs:readonly SaveImageAttachment[])=>Promise.all(inputs.map(saveImage))} as unknown as Context['attachments'])
    const installedRoot=process.env.DSH_VD_CONNECTION_QA_INSTALLED
    // The production Host provides peer modules. This harness supplies its matching
    // SDK instances without changing the installed package or profile dependencies.
    if(installedRoot)registerHooks({resolve(specifier,context,nextResolve){
      return nextResolve(specifier,specifier.startsWith('@deepseek-ai/')?{...context,parentURL:import.meta.url}:context)
    }})
    const pluginUrl=installedRoot?pathToFileURL(join(installedRoot,'lib/index.js')).href:new URL('../lib/index.js', import.meta.url).href
    evidence.runtime={node:process.versions.node,electron:process.versions.electron,pluginUrl}
    const plugin = await import(pluginUrl) as typeof import('../src/index.ts')
    const vmCommandQa = await prepareVmCommandQa(directory)
    await ctx.plugin(plugin, {
      workerTimeoutMs: 5000, nativeTimeoutMs: 15000, frameAgeMs: 60000, screenshotMaxDimension: 1280, screenshotMaxBytes: 512000,
      ...vmCommandQa?.config,
    })

    stage = 'deny PiP startup in workspace-write and never'
    const initial = await execute<Diagnostic>(diagnosticsTool)
    evidence.initial = initial
    assert.equal(initial.diagnosticChannel.backend, 'diagnostic-only')
    assert.equal(initial.nextTool, null)
    assert.equal(initial.childStartPermission, 'blocked')
    assert.equal(initial.desktop.status, 'disabled')
    assert.equal(initial.desktop.isolated, false)
    assert.equal(initial.desktop.window, null)
    assert.equal(initial.desktop.childSessionId, undefined)
    assert.equal(initial.desktop.connectionId, undefined)
    assert.equal(windows.child(), null)
    assert.equal(approvals.length, 0)
    const blocked = await invoke(openTool)
    assert.equal(blocked.isError, true)
    assert.match(blocked.content, /批准|审批|权限|permission|approval/i)
    evidence.blockedOpen = blocked
    assert.equal(windows.child(), null, 'The denied tool must leave no child session')
    assert.equal((await ctx.virtualDesktop.desktopStatus(signal)).status, 'disabled')
    assert.equal(approvals.length, 0)

    stage = 'open through chat tool using effective full-access session grant'
    permissionPreset = 'danger-full-access'
    sandboxMode = 'danger-full-access'
    const full = await execute<Diagnostic>(diagnosticsTool)
    assert.equal(full.nextTool, openTool)
    assert.equal(full.childStartPermission, 'session-grant')
    evidence.beforeFullOpen = full
    connected = true
    const coldApplication = applicationPath || vmCommandQa ? await execute<import('../src/native-contract.ts').ApplicationResult>('desktop_open_application',{appId:'vmware-workstation'}) : undefined
    if(coldApplication)evidence.coldApplication=coldApplication
    const opened = coldApplication ? {state:await execute<DesktopRuntimeState>(statusTool),windows:await execute<DesktopWindow[]>(listTool)} : await execute<{ state: DesktopRuntimeState; windows: DesktopWindow[] }>(openTool)
    assert.equal(approvals.length, 0, 'A standing connection grant must not ask for a one-shot grant')
    assert.ok(policyReads.approval > 0 && policyReads.preset > 0 && policyReads.sandbox > 0)
    const state = opened.state
    evidence.opened = { state, windowCount: opened.windows.length, windows: opened.windows }
    assert.equal(state.backend, 'windows-child-session')
    assert.equal(state.isolated, true)
    assert.equal(state.status, coldApplication ? 'enabled' : 'observing')
    assert.equal(state.parentSessionId, parentSessionId)
    assert.ok(state.childSessionId && state.childSessionId !== parentSessionId)
    assert.equal(state.childSessionId, windows.child())
    if(!coldApplication)assert.equal(state.window, null)
    assert.ok(opened.windows.every(window => windows!.session(window.pid) === state.childSessionId))
    const childSessionId = state.childSessionId
    const connectionId = requireConnectionId(state)
    evidence.childSessionId = childSessionId
    evidence.connectionId = connectionId

    if (verifyDisplay) {
      stage = 'compare PiP startup report and independent WTS display query'
      const wts = windows.clientDisplay(childSessionId)
      const diagnostic = await execute<Diagnostic>(diagnosticsTool)
      evidence.pipDisplay = { connectionId, childSessionId, broker: state.pipDisplay, diagnostics: diagnostic.desktop.pipDisplay, wts }
      assert.ok(state.pipDisplay && wts, 'Expected the broker and Windows to report the verified child display')
      assert.deepEqual(state.pipDisplay.requested, { width: 1920, height: 1080 })
      assert.deepEqual(state.pipDisplay.actual, wts)
      assert.deepEqual(diagnostic.desktop.pipDisplay, state.pipDisplay)
      if (coldApplication) assert.deepEqual(coldApplication.pipDisplay, state.pipDisplay)
    }

    if (vmCommandQa) {
      assert.equal(coldApplication?.status, 'ready', coldApplication?.message)
      await runVmCommandQa({
        fixture: vmCommandQa.fixture, state, windows, invoke, evidence,
        stage: value => { stage = value },
        async withRestrictedPolicy(run) {
          const previous = { permissionPreset, sandboxMode }
          permissionPreset = 'workspace-write'
          sandboxMode = 'workspace-write'
          try { await run() } finally {
            permissionPreset = previous.permissionPreset
            sandboxMode = previous.sandboxMode
          }
        },
      })
      assert.equal(approvals.length, 0, 'Full Access and never use the existing verified session grant')
      evidence.passed = true
      return
    }

    if (applicationPath) {
      stage = 'launch requested application in a fresh PiP through the tool'
      evidence.coldStartWithoutConnectedSession = true
      const imagePath=await realpath(applicationPath)
      const openedApp=coldApplication!
      assert.equal(openedApp.path.toLowerCase(),imagePath.toLowerCase())
      evidence.applicationOpen=openedApp
      assert.equal(approvals.length,0)
      assert.equal(openedApp.status,'ready',openedApp.message)
      const target=openedApp.window
      assert.ok(target)
      assert.equal(windows.session(target.pid),childSessionId)
      stage='bind and capture the requested application without sending input'
      const selected=await execute<DesktopRuntimeState>(statusTool)
      assert.equal(selected.window?.id,target.id)
      const frame=remote.methods['virtualDesktop/capture'].result.create().parse(await ownerRemote('capture',{source:'window',cropJson:''}))
      assert.equal(frame.windowId,target.id)
      const bytes=Buffer.from(frame.data,'base64')
      assert.ok((await sharp(bytes).stats()).channels.some(channel=>channel.stdev>5))
      await writeFile(join(directory,'application-window.jpg'),bytes)
      await writeFile(join(directory,'application-tree.txt'),frame.tree)
      const finalState=await execute<DesktopRuntimeState>(statusTool)
      assert.equal(finalState.window?.id,target.id)
      assert.ok(finalState.windowDiscovery?.sdkSelection)
      evidence.applicationWindow={...target,sessionId:windows.session(target.pid),frameWidth:frame.width,frameHeight:frame.height}
      evidence.discovery=finalState.windowDiscovery
      assert.doesNotMatch(target.title,/error|错误|unrecoverable/i,'Application exposed an error dialog, not a usable main window')
      evidence.passed=true
      return
    }

    if (launchFixture) {
      stage = 'launch fixture from an empty child session through the chat tool'
      evidence.startedWithoutApplicationWindows=opened.windows.length===0
      assert.ok(expectedImage)
      const before = await execute<{windows:DesktopWindow[];windowDiscovery:NonNullable<DesktopRuntimeState['windowDiscovery']>}>(listTool,{includeDiagnostics:true})
      assert.ok(!before.windows.some(window=>window.imagePath?.toLowerCase()===expectedImage?.toLowerCase()))
      assert.ok(before.windowDiscovery.systemSurfaces?.length)
      const args = {path:expectedImage,operationId:randomUUID()}
      const launched = await execute<{launch:{pid:number;outcome:string};state:DesktopRuntimeState}>('desktop_launch_in_child_session',args)
      assert.equal(launched.launch.outcome,'started')
      assert.equal(windows.session(launched.launch.pid),childSessionId)
      assert.equal(launched.state.window,null)
      assert.equal(launched.state.epoch,state.epoch)
      assert.equal(approvals.length,0,'Verified Full Access + never-ask launch uses the session grant')
      const duplicate = await execute<{launch:{pid:number}}>('desktop_launch_in_child_session',args)
      assert.equal(duplicate.launch.pid,launched.launch.pid,'Retry must return the same process receipt')
      evidence.bootstrap = {before,launched,duplicatePid:duplicate.launch.pid}
    }

    if (shellOnly) {
      stage = 'verify an active child shell without an application window'
      const listed = remote.methods['virtualDesktop/windows'].result.create().parse(await ownerRemote('windows'))
      const emptyStatus = remote.methods['virtualDesktop/desktopStatus'].result.create().parse(await ownerRemote('desktopStatus'))
      evidence.shellOnly = { status: emptyStatus, eligibleWindows: listed.length, discovery: emptyStatus.windowDiscovery }
      assert.equal(opened.windows.length, 0, 'The shell-only session opened with unexpected eligible applications')
      assert.equal(listed.length, 0, 'The owner picker must remain empty before any application is opened')
      const report = requireDiscovery(emptyStatus, 0)
      assert.ok(report.filtered.systemSurface > 0, 'Expected to identify and filter the child shell surface')
      assert.equal(emptyStatus.status, 'observing')
      assert.equal(emptyStatus.epoch, state.epoch)
      assert.equal(emptyStatus.connectionId, connectionId)
      assert.equal(emptyStatus.childSessionId, childSessionId)
      assert.equal(emptyStatus.window, null)
      assert.equal(windows.connectState(childSessionId), 0)
      assert.equal(approvals.length, 0)
      evidence.passed = true
      return
    }

    assert.ok(expectedImage)

    stage = 'discover exact fixture through chat tool'
    let target: DesktopWindow | undefined
    let baseline: FixtureState | null = null
    const discovery = AbortSignal.any([signal, AbortSignal.timeout(45000)])
    while (!target) {
      discovery.throwIfAborted()
      baseline = await readFixture()
      if (baseline) {
        assert.ok(Number.isSafeInteger(baseline.pid) && baseline.pid > 0)
        assert.equal(windows.session(baseline.pid), childSessionId)
        assert.equal((await realpath(windows.image(baseline.pid))).toLowerCase(), expectedImage.toLowerCase(), 'Saved state must belong to the copied fixture executable')
        assert.deepEqual([baseline.clicks, baseline.wheels, baseline.text], [0, 0, ''])
        const listed = await execute<DesktopWindow[]>(listTool, {}, discovery)
        const matches = listed.filter(window => window.pid === baseline!.pid && window.title === fixtureTitle)
        assert.ok(matches.length <= 1, 'More than one window matched the copied fixture')
        target = matches[0]
      }
      if (!target) await delay(200, undefined, { signal: discovery })
    }
    assert.ok(baseline)
    evidence.fixture = { ...target, baseline }

    stage = 'bind using full-access and never without a prompt'
    const boundByChat = await execute<DesktopRuntimeState>(selectTool,{windowId:target.id})
    assert.equal(boundByChat.window?.id,target.id)
    assert.equal(boundByChat.epoch,state.epoch+1)
    assert.equal(approvals.length,0)
    evidence.boundBySessionGrant=boundByChat
    const stillUnbound=boundByChat

    stage = 'bind the copied fixture through the owner panel gateway'
    const panelWindows = remote.methods['virtualDesktop/windows'].result.create().parse(await ownerRemote('windows'))
    assert.ok(panelWindows.every(window => windows!.session(window.pid) === childSessionId))
    assert.ok(!panelWindows.some(window => /^program manager$/i.test(window.title.trim())), 'Desktop shell appeared in the owner window picker')
    const visibleDiscoveryState = remote.methods['virtualDesktop/desktopStatus'].result.create().parse(await ownerRemote('desktopStatus'))
    const visibleDiscovery = requireDiscovery(visibleDiscoveryState, panelWindows.length)
    assert.equal(visibleDiscoveryState.epoch, stillUnbound.epoch)
    assert.equal(visibleDiscoveryState.connectionId, connectionId)
    const panelTarget = panelWindows.filter(window => window.id === target!.id)
    assert.equal(panelTarget.length, 1, 'The owner panel must rediscover the same opaque fixture ID')
    assert.deepEqual([panelTarget[0].pid, panelTarget[0].app, panelTarget[0].title], [target.pid, target.app, target.title])
    const childStateBefore = windows.connectState(childSessionId)
    assert.equal(childStateBefore, 0, 'The child must be WTSActive before owner selection')
    const selectedByPanel = remote.methods['virtualDesktop/selectWindow'].result.create().parse(await ownerRemote('selectWindow', {
      windowId: panelTarget[0].id, foreground: false,
    }))
    function assertFixtureBound(bound: DesktopRuntimeState, epoch: number) {
      assert.equal(bound.status, 'enabled')
      assert.equal(bound.backend, 'windows-child-session')
      assert.equal(bound.isolated, true)
      assert.equal(bound.foregroundAllowed, false)
      assert.equal(bound.parentSessionId, parentSessionId)
      assert.equal(bound.childSessionId, childSessionId)
      assert.equal(bound.connectionId, connectionId)
      assert.equal(bound.epoch, epoch)
      assert.deepEqual(bound.window && [bound.window.id, bound.window.pid, bound.window.app, bound.window.title],
        [target!.id, target!.pid, target!.app, target!.title])
    }
    assertFixtureBound(selectedByPanel, stillUnbound.epoch + 1)
    evidence.ownerPanel = { before: stillUnbound, selected: selectedByPanel, childStateBefore, discovery: visibleDiscovery }

    stage = 'verify the panel binding through chat and live worker capture'
    const panelState = remote.methods['virtualDesktop/desktopStatus'].result.create().parse(await ownerRemote('desktopStatus'))
    assertFixtureBound(panelState, selectedByPanel.epoch)
    const taskState = await execute<DesktopRuntimeState & { task: unknown }>(statusTool)
    assertFixtureBound(taskState, selectedByPanel.epoch)
    assert.equal(taskState.task, null, 'Window binding must not start a task')
    assert.equal(approvals.length, 0, 'The explicit panel binding must not create a chat approval')
    evidence.ownerPanelStatus = panelState
    evidence.chatStatusAfterPanel = taskState

    stage = 'read the existing binding after reconnecting the owner panel'
    await owner.dispose()
    owner = ownerPeer('connection-qa-reloaded-owner')
    const reloaded = remote.methods['virtualDesktop/desktopStatus'].result.create().parse(await ownerRemote('desktopStatus'))
    assertFixtureBound(reloaded, selectedByPanel.epoch)
    evidence.ownerPanelReconnect = { sameConnection: reloaded.connectionId === connectionId, epoch: reloaded.epoch }

    async function saveFixtureCapture(file: string) {
      const frame = remote.methods['virtualDesktop/capture'].result.create().parse(await ownerRemote('capture', { source: 'window', cropJson: '' }))
      assert.equal(frame.source, 'window')
      assert.equal(frame.windowId, panelTarget[0].id)
      assert.equal(frame.epoch, selectedByPanel.epoch)
      assert.equal(frame.mimeType, 'image/jpeg')
      const jpeg = Buffer.from(frame.data, 'base64')
      const image = sharp(jpeg, { limitInputPixels: 2000000 })
      const metadata = await image.metadata()
      assert.deepEqual([metadata.format, metadata.width, metadata.height], ['jpeg', frame.width, frame.height])
      assert.ok((await image.stats()).channels.some(channel => channel.stdev > 5), 'Expected a nonblank fixture screenshot')
      await writeFile(join(directory!, file), jpeg, { flag: 'wx' })
      return { file, frameId: frame.id, epoch: frame.epoch, width: frame.width, height: frame.height, sha256: createHash('sha256').update(jpeg).digest('hex') }
    }
    const visibleCapture = await saveFixtureCapture('connection-fixture.jpg')
    assert.equal(windows.child(), childSessionId)
    assert.equal(windows.session(target.pid), childSessionId)
    const childStateAfter = windows.connectState(childSessionId)
    assert.equal(childStateAfter, 0, 'The same child must remain WTSActive after owner capture')
    evidence.childStateAfterOwnerCapture = childStateAfter
    evidence.screenshot = visibleCapture

    if (verifyMinimized) {
      stage = 'wait for the operator to minimize the verified QA viewer'
      const viewer = windows.viewer(process.pid)
      assert.equal(windows.session(viewer.viewerPid), parentSessionId)
      const expectedViewer = await realpath(fileURLToPath(new URL('../lib/child-session-host/ChildSessionHost.exe', import.meta.url)))
      assert.equal((await realpath(windows.image(viewer.viewerPid))).toLowerCase(), expectedViewer.toLowerCase(), 'The viewer is not the companion built for this QA run')
      assert.equal(windows.viewerIsMinimized(viewer), false, 'Expected the QA viewer to be visible before the operator handshake')
      const ready = {
        viewerPid: viewer.viewerPid, viewerHwnd: String(viewer.hwnd), viewerTitle, hostPid: process.pid,
        parentSessionId, childSessionId, connectionId, epoch: selectedByPanel.epoch, at: Date.now(),
      }
      await writeFile(join(directory, 'ready-to-minimize.json'), `${JSON.stringify(ready, null, 2)}\n`, { flag: 'wx' })
      const waitForMinimize = AbortSignal.any([signal, AbortSignal.timeout(240000)])
      while (!windows.viewerIsMinimized(viewer)) await delay(100, undefined, { signal: waitForMinimize })
      const minimizedAt = Date.now()
      assert.equal(windows.connectState(childSessionId), 0)

      stage = 'rediscover and capture the same target while the QA viewer is minimized'
      const minimizedWindows = remote.methods['virtualDesktop/windows'].result.create().parse(await ownerRemote('windows'))
      assert.ok(minimizedWindows.every(window => windows!.session(window.pid) === childSessionId))
      assert.ok(!minimizedWindows.some(window => /^program manager$/i.test(window.title.trim())))
      const rediscovered = minimizedWindows.filter(window => window.id === panelTarget[0].id)
      assert.equal(rediscovered.length, 1, 'The minimized viewer must not hide or replace the fixture ID')
      assert.deepEqual([rediscovered[0].pid, rediscovered[0].app, rediscovered[0].title], [target.pid, target.app, target.title])
      const minimizedStatus = remote.methods['virtualDesktop/desktopStatus'].result.create().parse(await ownerRemote('desktopStatus'))
      const minimizedDiscovery = requireDiscovery(minimizedStatus, minimizedWindows.length)
      assertFixtureBound(minimizedStatus, selectedByPanel.epoch)
      const chatMinimized = await execute<DesktopRuntimeState & { task: unknown }>(statusTool)
      assertFixtureBound(chatMinimized, selectedByPanel.epoch)
      assert.equal(chatMinimized.task, null)
      assert.equal(windows.viewerIsMinimized(viewer), true, 'The QA viewer was restored before the capture')
      const minimizedCapture = await saveFixtureCapture('connection-fixture-minimized.jpg')
      assert.notEqual(minimizedCapture.frameId, visibleCapture.frameId)
      assert.equal(windows.viewerIsMinimized(viewer), true, 'The QA viewer was restored during the capture')
      assert.equal(windows.connectState(childSessionId), 0)
      evidence.minimized = { ready, minimizedAt, status: minimizedStatus, discovery: minimizedDiscovery, chatStatus: chatMinimized, screenshot: minimizedCapture }
    }

    if (captionWidth) {
      stage = 'click the Win32 caption minimize button using chat screenshot pixels'
      const fixture = await readFixture() as FixtureState & {
        windowWidth: number; windowHeight: number; captionMinX: number; captionMinY: number
        captionHit: number; dwmX: number; dwmY: number; dwmWidth: number; dwmHeight: number
      }
      assert.equal(fixture.windowWidth, captionWidth)
      assert.equal(fixture.windowHeight, 859)
      assert.equal(fixture.captionHit, 8, 'The fixture must prove HTMINBUTTON at the screen point')
      const screenshot = await invoke(screenshotTool)
      assert.equal(screenshot.isError, false, screenshot.content)
      const frame = (screenshot.raw.value as any).structuredContent as DesktopFrame
      assert.equal(frame.width, 1280)
      assert.ok(frame.scale && frame.scale.rawWidth > frame.width)
      // SDK Windows capture crops one physical pixel inside DWM extended frame bounds.
      const x = (fixture.captionMinX - fixture.dwmX - 1) * frame.width / (fixture.dwmWidth - 2)
      const y = (fixture.captionMinY - fixture.dwmY - 1) * frame.height / (fixture.dwmHeight - 2)
      const parentBefore = windows.hostInput()
      const action = await invoke('desktop_execute_action', {
        operationId: randomUUID(), frameId: frame.id, epoch: frame.epoch, delivery: 'background',
        action: { type: 'click', button: 'left', count: 1, x, y },
      })
      await delay(300, undefined, { signal })
      const after = await invoke(screenshotTool)
      const receipt = action.raw.value as { structuredContent?: unknown } | undefined
      evidence.caption = {
        fixture, frame: { id: frame.id, width: frame.width, height: frame.height, scale: frame.scale },
        input: { x, y }, action: { error: action.isError, text: action.content, receipt: receipt?.structuredContent },
        after: { error: after.isError, text: after.isError ? after.content : undefined },
        pipDisplay: (await execute<DesktopRuntimeState>(statusTool)).pipDisplay,
      }
      assert.equal(action.isError, false, action.content)
      assert.equal(after.isError, true, 'A screenshot-coordinate caption click must minimize the fixture')
      assert.equal(JSON.parse(after.content).reason, 'minimized')
      if (process.env.DSH_VD_CAPTION_RECEIPT_QA === '1') {
        const applied = JSON.parse(action.content)
        assert.equal(applied.outcome, 'delivered')
        assert.deepEqual(applied.postAction, { reason: 'minimized', nextTool: 'desktop_restore_window' })
        assert.deepEqual(applied.sourceScale, frame.scale)
        assert.ok(Math.abs(applied.effectivePoint.x - x * frame.scale.rawWidth / frame.width) < 1)
        assert.ok(Math.abs(applied.effectivePoint.y - y * frame.scale.rawHeight / frame.height) < 1)
      }
      const state = await execute<DesktopRuntimeState>(statusTool)
      const restored = await execute<DesktopRuntimeState>('desktop_restore_window', {
        connectionId: state.connectionId, epoch: state.epoch, windowId: target.id, pid: target.pid,
      })
      assert.equal(restored.window?.id, target.id)
      assert.equal(restored.window?.pid, target.pid)
      assert.equal((await invoke(screenshotTool)).isError, false)
      assert.deepEqual(windows.hostInput(), parentBefore)
      evidence.passed = true
      return
    }

    stage = 'verify real child input using the full-access session grant'
    const parentInput=windows.hostInput()
    const inputReceipts=[]
    for(const kind of ['click','type','scroll'] as const){
      const current=await readFixture();assert.ok(current)
      const frame=remote.methods['virtualDesktop/capture'].result.create().parse(await ownerRemote('capture',{source:'window',cropJson:''}))
      const screenX=kind==='click'?current.buttonX:kind==='type'?current.textX:current.scrollX
      const screenY=kind==='click'?current.buttonY:kind==='type'?current.textY:current.scrollY
      const x=(screenX-target.x)*frame.width/target.width,y=(screenY-target.y)*frame.height/target.height
      const action=kind==='type'?{type:kind,x,y,text:'PiP native broker QA'}:kind==='scroll'?{type:kind,x,y,direction:'down',amount:3}:{type:kind,x,y,button:'left',count:1}
      const result=await invoke('desktop_execute_action',{operationId:randomUUID(),frameId:frame.id,epoch:frame.epoch,delivery:'background',action})
      assert.equal(result.isError,false,result.content)
      await delay(250,undefined,{signal})
      const observed=await readFixture();assert.ok(observed)
      if(kind==='click')assert.equal(observed.clicks,baseline.clicks+1)
      if(kind==='type')assert.equal(observed.text,'PiP native broker QA')
      if(kind==='scroll')assert.ok(observed.scrollOffsetY>0)
      assert.deepEqual(windows.hostInput(),parentInput,'Child input must preserve the parent cursor and focus')
      if(verifyMinimized)assert.equal(windows.viewerIsMinimized(windows.viewer(process.pid)),true)
      inputReceipts.push({action:kind,observed})
    }
    evidence.directInput={parentInputUnchanged:true,minimized:verifyMinimized,results:inputReceipts}
    const afterInputs=await readFixture();assert.ok(afterInputs)
    assert.equal(approvals.length,0)

    if(defects){
      stage='D1 wide fixture and D3 readable file with rejected attachment'
      const fresh=await readFixture() as any
      assert.equal(fresh.windowWidth,1920,'Fixture must really be 1920 pixels wide')
      const capture=await ctx.virtualDesktop.capture('window','',signal)
      assert.ok(capture.scale);assert.equal(capture.width,1280);assert.ok(capture.filePath)
      const admitted=await invoke(screenshotTool)
      assert.equal(admitted.isError,false);assert.ok(admitted.raw.content.some(b=>b.type==='image'))
      rejectImages=true
      const rejected=await invoke(screenshotTool)
      assert.equal(rejected.isError,false)
      const rejectedValue=(rejected.raw.value as any).structuredContent
      assert.equal(rejectedValue.attachmentError.code,'EDQUOT');assert.ok(rejectedValue.filePath)
      await access(rejectedValue.filePath)
      await writeFile(join(directory,'read-image-ready.json'),JSON.stringify({filePath:rejectedValue.filePath}))
      const viewDeadline=Date.now()+60000
      while(Date.now()<viewDeadline){try{await access(join(directory,'read-image-ack'));break}catch{await delay(100)}}
      await access(join(directory,'read-image-ack'))
      rejectImages=false
      evidence.imageStorage={filePath:rejectedValue.filePath,error:rejectedValue.attachmentError,scale:capture.scale,widePixels:fresh.windowWidth}

      const send=async(action:any)=>{
        const f=await ctx.virtualDesktop.capture('window','',signal)
        const result=await invoke('desktop_execute_action',{operationId:randomUUID(),frameId:f.id,epoch:f.epoch,action})
        assert.equal(result.isError,false,result.content)
        await delay(200);return result
      }
      const point=(x:number,y:number)=>({x:(x-target.x)*capture.width/target.width,y:(y-target.y)*capture.height/target.height})
      stage='D2 minimize target and restore same identity without a frame'
      await send({type:'click',...point(fresh.minimizeX,fresh.minimizeY)})
      const minimized=await invoke(screenshotTool)
      assert.equal(minimized.isError,true)
      assert.equal(JSON.parse(minimized.content).reason,'minimized')
      const current=await execute<DesktopRuntimeState>(statusTool)
      const restored=await execute<DesktopRuntimeState>('desktop_restore_window',{connectionId:current.connectionId,epoch:current.epoch,windowId:target.id,pid:target.pid})
      assert.equal(restored.window?.id,target.id);assert.equal(restored.window?.pid,target.pid)
      assert.ok((await ctx.virtualDesktop.capture('window','',signal)).filePath)
      await send({type:'click',...point(fresh.buttonX,fresh.buttonY)})
      assert.equal((await readFixture())!.clicks,afterInputs.clicks+1)
      evidence.restored={minimized:JSON.parse(minimized.content),windowId:target.id,pid:target.pid,after:await readFixture()}

      stage='D4 real background keys and double click'
      await send({type:'click',...point(fresh.textX,fresh.textY)})
      const beforeKeys=await readFixture() as any
      for(const [key,modifiers] of [['enter',[]],['esc',[]],['k',['ctrl']]] as const)await send({type:'key',...point(fresh.textX,fresh.textY),key,modifiers})
      await send({type:'click',...point(fresh.targetX,fresh.targetY),count:2})
      const afterKeys=await readFixture() as any
      assert.equal(afterKeys.enters,beforeKeys.enters+1);assert.equal(afterKeys.escapes,beforeKeys.escapes+1);assert.equal(afterKeys.ctrlKeys,beforeKeys.ctrlKeys+1)
      assert.equal(afterKeys.doubles,beforeKeys.doubles+1)
      assert.deepEqual(windows.hostInput(),parentInput)
      evidence.backgroundKeys={before:beforeKeys,after:afterKeys,parentInputUnchanged:true}

      stage='D5 stop immediately followed by open_application'
      await execute(stopTool)
      const started=Date.now()
      const opening=await invoke('desktop_open_application',{path:expectedImage,operationId:randomUUID()})
      assert.doesNotMatch(opening.content,/EPIPE/)
      if(opening.isError){const error=JSON.parse(opening.content);assert.ok(error.retryAfterMs>0);assert.ok(error.nextTool)}
      evidence.stopOpen={elapsedMs:Date.now()-started,result:opening.content,isError:opening.isError}
      await assert.rejects(access(rejectedValue.filePath),{code:'ENOENT'})
      evidence.passed=true;return
    }

    stage = 'bind through chat tool after switching to ask'
    approvalPolicy = 'ask'
    permissionPreset = 'workspace-write'
    sandboxMode = 'workspace-write'
    const selected = await execute<DesktopRuntimeState>(selectTool, { windowId: target.id })
    evidence.selected = selected
    assertFixtureBound(selected, selectedByPanel.epoch + 1)
    const grants = approvals.filter(item => item.allowed)
    assert.deepEqual(grants.map(item => item.toolName), [selectTool])
    assert.ok(grants[0].reason?.includes(JSON.stringify({ title: target.title, app: target.app, pid: target.pid, windowId: target.id })))

    stage = 'diagnose after chat rebind and verify fixture remained unchanged'
    const diagnostic = await execute<Diagnostic>(diagnosticsTool)
    assert.equal(diagnostic.nextTool, screenshotTool)
    assert.equal(diagnostic.childStartPermission, 'ask')
    assert.equal(diagnostic.desktop.window?.id, target.id)
    evidence.afterBinding = diagnostic
    assert.equal(windows.child(), childSessionId)
    assert.equal(windows.session(target.pid), childSessionId)
    const final = await readFixture()
    assert.ok(final)
    assert.deepEqual([final.pid, final.clicks, final.wheels, final.text], [afterInputs.pid, afterInputs.clicks, afterInputs.wheels, afterInputs.text])
    evidence.passed = true
  } catch (error) {
    evidence.stage = stage
    evidence.error = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      if (connected) {
        const stopping = AbortSignal.timeout(18000)
        const stopped = await execute<DesktopRuntimeState>(stopTool, {}, stopping)
        assert.equal(stopped.status, 'stopped')
        assert.equal(stopped.window, null)
        assert.equal(stopped.connectionId, undefined)
        while (windows?.child() !== null) await delay(100, undefined, { signal: stopping })
        evidence.stopped = true
      }
    } catch (error) {
      evidence.passed = false
      evidence.stopError = error instanceof Error ? error.message : String(error)
    } finally {
      const cleanup = await Promise.allSettled([owner.dispose(), ctx.fiber.dispose()])
      const failure = cleanup.find(result => result.status === 'rejected')
      if (failure) {
        evidence.passed = false
        evidence.disposeError = failure.reason instanceof Error ? failure.reason.message : String(failure.reason)
      }
      clearTimeout(watchdog)
      evidence.endedAt = Date.now()
      await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
      console.log(JSON.stringify({ passed: evidence.passed, report: reportPath, error: evidence.error ?? evidence.stopError ?? evidence.disposeError }))
      if (!evidence.passed) process.exitCode = 1
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
