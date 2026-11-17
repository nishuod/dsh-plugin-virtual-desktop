import { ApplicationLifecycle, type ApplicationAuthorization } from './application-lifecycle.ts'
import { applicationInput } from './application-catalog.ts'
import type { ApplicationResult } from './native-contract.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, principalOf, bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { DiagnosticState } from './diagnostics.ts'
import { DiagnosticWorker } from './worker-client.ts'
import { PROTOCOL_VERSION } from './protocol.ts'
import type { NativeSession } from './native-session.ts'
import type {DesktopWindow,DesktopFrame,DesktopRuntimeState,DesktopReceipt,ChildLaunchReceipt,RestoreWindowResult} from './native-contract.ts'
import type { TaskRoute, TaskSnapshot } from './task-contract.ts'
import { VmAdapter, type VmAdapterOptions, type VmCommandInput } from './vm-adapter.ts'
import { VmCommandService, type VmCommandReceipt, type VmPowerAuthorization } from './vm-command-service.ts'
import { DiagnosticJournal } from './diagnostic-export.ts'
import { redactDiagnostics } from './redaction.ts'
import { z } from 'zod'
import type { ChildSessionResetResult } from './reset-contract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { virtualDesktop: VirtualDesktopController }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Desktop diagnostics are available only to the authenticated owner. */
    'virtual-desktop/owner-required': { readonly operation: string }
    /** The child process is unavailable. No desktop operation was attempted. */
    'virtual-desktop/worker-unavailable': { readonly operation: string }
    'virtual-desktop/task-rejected': { readonly operation: string }
  }
}

// Keep the Remote face independent of the model and Session SDK graphs.
interface DesktopTaskAccess {
  routes(signal: AbortSignal): Promise<TaskRoute[]>
  snapshot(): TaskSnapshot | null
  assertIdle(): void
  start(request: unknown, signal: AbortSignal): Promise<TaskSnapshot>
  frame(taskId: string, frameId: string): DesktopFrame
  answer(taskId: string, reviewId: string, answer: 'approve' | 'reject'): TaskSnapshot
  control(command: 'pause' | 'resume' | 'stop', signal: AbortSignal): Promise<DesktopRuntimeState>
  close(): Promise<void>
}

/** Owner-only Remote control for local input and observed tasks. */
export class VirtualDesktopController extends Service {
  readonly typertRemote = bindTypertRemote(this, 'virtualDesktop', { namespace: 'virtualDesktop' })
  private readonly applications: ApplicationLifecycle
  private readonly vmCommands: VmCommandService
  private status: DiagnosticState['status'] = 'starting'
  private probes = 0
  private feedback = '等待诊断进程就绪'
  private readonly journal = new DiagnosticJournal(redactDiagnostics)
  private readonly experimentalTasks: boolean
  private resetting?:Promise<ChildSessionResetResult>
  private readonly resetReceipts = new Map<string, Promise<ChildSessionResetResult>>()
  private enablingLocal = false
  private applicationAbort=new AbortController()
  constructor(ctx: Context, private readonly worker: DiagnosticWorker,
    private readonly native: NativeSession, private readonly tasks: DesktopTaskAccess, vmOptions: VmAdapterOptions & {experimentalTasks?:boolean} = {}) {
    super(ctx, 'virtualDesktop')
    this.applications = new ApplicationLifecycle(native)
    this.vmCommands = new VmCommandService(native, new VmAdapter(vmOptions))
    this.experimentalTasks = vmOptions.experimentalTasks === true
  }

  private assertDesktopIdle(): void {
    if(this.resetting)throw new Error('子会话正在重置，请等待清理完成')
    this.tasks.assertIdle()
    this.applications.assertIdle()
    this.vmCommands.assertIdle()
  }

  /** Initialize the owned diagnostic child, or roll back before claiming readiness. */
  async initialize(signal: AbortSignal): Promise<void> {
    try { await this.worker.start(signal); this.status = 'ready'; this.feedback = 'IPC 握手通过；未启用桌面输入' }
    catch (error) { this.status = 'failed'; await this.worker.close(); throw error }
  }

  /** @returns a snapshot with explicit simulated/native capability boundaries. */
  snapshot(): DiagnosticState {
    return { stage: 'phase2', status: this.status, backend: 'diagnostic-only',
      nativeDesktop: false, inputEnabled: false, isolated: false,
      protocolVersion: PROTOCOL_VERSION, workerPid: this.worker.pid ?? null,
      probes: this.probes, lastFeedback: this.feedback, completionPolicy: 'external-evaluator-required' }
  }
  recordToolFailure(tool:string,error:{message?:string;reason?:string;nextTool?:string}):void {
    this.journal.record('tool-failed',{tool,message:error.message,reason:error.reason,nextTool:error.nextTool})
  }

  /** @param signal - call cancellation. @returns owner-visible diagnostic state. */
  @Remote('status')
  async remoteStatus(signal: AbortSignal): Promise<DiagnosticState> {
    this.assertOwner('status'); signal.throwIfAborted(); return this.snapshot()
  }

  /** @param signal - forwarded to the worker. @returns a fresh IPC acknowledgement. */
  @Remote('probe')
  async remoteProbe(signal: AbortSignal): Promise<DiagnosticState> {
    this.assertOwner('probe')
    try {
      const reply = await this.worker.request('probe', signal)
      this.probes++
      this.feedback = `收到诊断进程反馈 #${reply.sequence}；没有桌面动作`
      return this.snapshot()
    } catch (error) {
      this.status = 'failed'; this.feedback = '诊断进程不可用，未自动重启或重放'
      signal.throwIfAborted()
      throw new RemoteError('virtual-desktop/worker-unavailable', this.feedback, { operation: 'probe' }, { cause: error })
    }
  }

  private assertOwner(operation: string): void {
    if (principalOf(this.ctx.invocation)) {
      throw new RemoteError('virtual-desktop/owner-required', '仅当前 Host 所有者可以读取或调用桌面诊断', { operation })
    }
  }

  /** Read local runtime status without granting access. */
  @Remote('desktopStatus')
  async desktopStatus(signal:AbortSignal):Promise<DesktopRuntimeState>{this.assertOwner('desktopStatus');return await this.native.status(signal)}
  @Remote('applicationStatus')
  async applicationStatus(signal:AbortSignal):Promise<{status:string;stage:string;startedAt:number;elapsedMs:number;operationId:string}|null>{this.assertOwner('applicationStatus');signal.throwIfAborted();return this.applications.snapshot()}
  /** Owner UI explicitly grants reading this local Windows desktop. */
  @Remote('enableLocal')
  async enableLocal(signal: AbortSignal): Promise<DesktopRuntimeState> {
    this.assertOwner('enableLocal')
    this.assertDesktopIdle()
    if (this.enablingLocal) throw new Error('正在连接本机桌面，请等待连接完成')
    this.enablingLocal = true
    try { return await this.native.enable(signal) }
    finally { this.enablingLocal = false }
  }
  /** Owner-only, explicit selection of a verified Windows child session. */
  @Remote('enableChildSession')
  async enableChildSession(signal: AbortSignal): Promise<DesktopRuntimeState> {
    return await this.taskRemote('enableChildSession', () => {
      this.assertDesktopIdle()
      return this.native.enable(signal, 'windows-child-session')
    })
  }
  /** List eligible windows after the owner enabled observation. */
  @Remote('windows')
  async windows(signal:AbortSignal):Promise<DesktopWindow[]>{this.assertOwner('windows');return await this.native.windows(signal)}
  /** Owner launch in the verified child, independent of a selected window. */
  @Remote('launchChildApplication')
  async launchChildApplication(path: string, operationId: string, connectionId: string, expectedEpoch: number, signal: AbortSignal): Promise<ChildLaunchReceipt> {
    return await this.taskRemote('launchChildApplication', () => {
      this.assertDesktopIdle()
      return this.native.launch(path, operationId, connectionId, expectedEpoch, signal)
    })
  }
  /** One owner action resolves, launches, verifies and binds the requested application. */
  @Remote('openApplication')
  async openApplication(request: string, signal: AbortSignal): Promise<ApplicationResult> {
    return await this.taskRemote('openApplication', () => this.openApplicationApproved(request, async () => {}, signal))
  }
  async openApplicationApproved(request: string, authorize: ApplicationAuthorization, signal: AbortSignal): Promise<ApplicationResult> {
    if(this.resetting)throw new Error('子会话正在重置，请等待清理完成')
    this.assertOwner('openApplication'); this.tasks.assertIdle()
    this.vmCommands.assertIdle()
    if(request.length>3000)throw new Error('应用参数超过上限')
    const started=Date.now()
    try {
      const result=await this.applications.open(applicationInput.parse(JSON.parse(request)), authorize, AbortSignal.any([signal,this.applicationAbort.signal]))
      const {frame,...metadata}=result
      this.journal.record('application',{...metadata,elapsedMs:Date.now()-started})
      if(frame)this.journal.frame(frame)
      return result
    } catch(error){this.journal.record('application-failed',{elapsedMs:Date.now()-started,message:error instanceof Error?error.message:String(error)});throw error}
  }
  async vmCommandApproved(request: VmCommandInput, authorize: VmPowerAuthorization | undefined, signal: AbortSignal): Promise<VmCommandReceipt> {
    this.assertOwner('desktop_vm_command')
    const assertOtherOperationsIdle = () => {
      if(this.resetting)throw new Error('子会话正在重置，请等待清理完成')
      this.tasks.assertIdle()
      this.applications.assertIdle()
    }
    assertOtherOperationsIdle()
    const result=await this.vmCommands.execute(request, authorize, signal, assertOtherOperationsIdle)
    this.journal.record('vm-command',result)
    return result
  }
  /** Bind local input permission to exactly one discovered window. */
  @Remote('selectWindow')
  async selectWindow(windowId:string,foreground:boolean,signal:AbortSignal):Promise<DesktopRuntimeState>{this.assertOwner('selectWindow');this.assertDesktopIdle();return await this.native.select(windowId,foreground,signal)}
  /** The chat approval is bound to the child worker's observed epoch. */
  async selectWindowApproved(windowId: string, expectedEpoch: number, signal: AbortSignal): Promise<DesktopRuntimeState> {
    this.assertOwner('selectWindowApproved')
    this.assertDesktopIdle()
    return await this.native.select(windowId, false, signal, expectedEpoch)
  }
  async restoreWindowApproved(windowId:string,pid:number,connectionId:string,expectedEpoch:number,signal:AbortSignal):Promise<RestoreWindowResult>{
    this.assertOwner('restoreWindowApproved');this.assertDesktopIdle()
    return await this.native.restore(windowId,pid,connectionId,expectedEpoch,signal)
  }
  /** Capture a bounded real observation; desktop frames cannot authorize input. */
  @Remote('capture')
  async capture(source:'window'|'desktop',cropJson:string,signal:AbortSignal):Promise<DesktopFrame>{
    this.assertOwner('capture');this.assertDesktopIdle()
    const started=Date.now(),frame=await this.native.capture(source,cropJson===''?undefined:JSON.parse(cropJson),signal)
    this.journal.frame(frame);this.journal.record('capture',{id:frame.id,epoch:frame.epoch,width:frame.width,height:frame.height,privacy:frame.privacy,elapsedMs:Date.now()-started})
    return frame
  }
  /** One owner-reviewed manual action. No consent booleans are accepted from model tools. */
  @Remote('manualAction')
  async manualAction(operationJson:string,signal:AbortSignal):Promise<DesktopReceipt>{this.assertOwner('manualAction');this.assertDesktopIdle();if(operationJson.length>16384)throw new Error('动作过大');return await this.executeApproved(JSON.parse(operationJson),signal)}
  /** Close admission first and await executor drain before reporting paused/stopped. */
  @Remote('control')
  async control(command:'pause'|'resume'|'stop',signal:AbortSignal):Promise<DesktopRuntimeState>{
    this.assertOwner('control')
    if(command==='stop'){this.applicationAbort.abort();this.applicationAbort=new AbortController()}
    try{return await this.taskRemote('control', () => this.tasks.control(command, signal))}
    finally{if(command==='stop')this.journal.clearFrames();this.journal.record('control',{command})}
  }
  @Remote('resetChildSession')
  async resetChildSession(operationId:string,signal:AbortSignal):Promise<ChildSessionResetResult>{
    this.assertOwner('resetChildSession')
    z.uuid().parse(operationId);signal.throwIfAborted()
    const previous = this.resetReceipts.get(operationId)
    if (previous) return structuredClone(await previous)
    if (this.resetReceipts.size >= 256) throw new Error('本 Host 的重置请求已达上限；旧请求不会被重新执行')

    if (!this.resetting) {
      const run: Promise<ChildSessionResetResult> = this.resetOwnedChildSession(operationId, signal)
        .finally(() => { if (this.resetting === run) this.resetting = undefined })
      this.resetting = run
    }
    // Reserve before awaiting cleanup. Same IDs share both pending and settled receipts.
    const receipt = this.resetting.then(
      result => ({ ...result, operationId }),
      error => { this.resetReceipts.delete(operationId); throw error },
    )
    this.resetReceipts.set(operationId, receipt)
    return structuredClone(await receipt)
  }

  private async resetOwnedChildSession(operationId: string, signal: AbortSignal): Promise<ChildSessionResetResult> {
    // Attended enable can be in the lifecycle join before status reports a connection.
    if (this.enablingLocal) throw new Error('正在连接本机桌面；子会话重置不会终止该连接')
    const releasedPids=this.native.trackOwnedChildRelease()
    this.applicationAbort.abort();this.applicationAbort=new AbortController()
    const state=await this.native.status(signal)
    if(state.backend==='windows-attended'&&!['disabled','stopped','failed'].includes(state.status))throw new Error('当前连接是本机桌面；子会话重置不会终止该连接')
    try{await this.tasks.control('stop',signal)}catch{ /* Reset must work after a transport failure. */ }
    try{
      const runtime=await this.native.resetChildSession(signal),pids=releasedPids()
      const receipt:ChildSessionResetResult={...runtime,operationId,state:pids.length?'released':'idle',releasedPids:pids}
      this.journal.record('reset-child-session',{operationId,state:receipt.state,releasedPids:pids})
      return receipt
    }finally{this.journal.clearFrames()}
  }
  @Remote('exportDiagnostics')
  async exportDiagnostics(recentFrames:number,signal:AbortSignal):Promise<{filePath:string;sha256:string;frames:number;logWriteFailures:number}>{
    this.assertOwner('exportDiagnostics');signal.throwIfAborted()
    const desktop=await this.native.status(signal)
    return await this.journal.export({diagnostic:this.snapshot(),desktop,task:this.tasks.snapshot()},recentFrames)
  }
  /** Tool execution is admitted only after the DSH approval service returns allowed-once. */
  async executeApproved(operation:unknown,signal:AbortSignal):Promise<DesktopReceipt>{
    this.assertDesktopIdle()
    const started=Date.now()
    try{
      const result=await this.native.execute(operation,signal),{after,...receipt}=result
      this.journal.record('action',{...receipt,elapsedMs:Date.now()-started});if(after)this.journal.frame(after)
      return result
    }catch(error){this.journal.record('action-failed',{elapsedMs:Date.now()-started,message:error instanceof Error?error.message:String(error)});throw error}
  }

  @Remote('taskRoutes')
  async taskRoutes(signal: AbortSignal): Promise<TaskRoute[]> {
    return await this.taskRemote('taskRoutes', () => this.tasks.routes(AbortSignal.any([signal, AbortSignal.timeout(15000)])))
  }

  @Remote('taskStatus')
  async taskStatus(signal: AbortSignal): Promise<TaskSnapshot | null> {
    this.assertOwner('taskStatus')
    signal.throwIfAborted()
    return this.tasks.snapshot()
  }

  @Remote('taskFrame')
  async taskFrame(taskId: string, frameId: string, signal: AbortSignal): Promise<DesktopFrame> {
    return await this.taskRemote('taskFrame', async () => {
      signal.throwIfAborted()
      return this.tasks.frame(taskId, frameId)
    })
  }

  @Remote('startTask')
  async startTask(request: string, signal: AbortSignal): Promise<TaskSnapshot> {
    return await this.taskRemote('startTask', async () => {
      if(this.resetting)throw new Error('子会话正在重置，请等待清理完成')
      if(!this.experimentalTasks)throw Object.assign(new Error('desktop_start_task is experimental and disabled; enable experimentalTasks explicitly'),{reason:'experimental-disabled',nextTool:'desktop_get_task_status'})
      this.applications.assertIdle()
      this.vmCommands.assertIdle()
      if (request.length > 12000) throw new Error('任务参数超过上限')
      return await this.tasks.start(JSON.parse(request), AbortSignal.any([signal, AbortSignal.timeout(15000)]))
    })
  }

  @Remote('answerTask')
  async answerTask(taskId: string, reviewId: string, answer: 'approve' | 'reject', signal: AbortSignal): Promise<TaskSnapshot> {
    return await this.taskRemote('answerTask', async () => {
      signal.throwIfAborted()
      return this.tasks.answer(taskId, reviewId, answer)
    })
  }

  private async taskRemote<T>(operation: string, work: () => Promise<T>): Promise<T> {
    this.assertOwner(operation)
    try {
      return await work()
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 480) : '任务请求失败'
      const details=error as {reason?:string;nextTool?:string;retryAfterMs?:number}
      this.journal.record('remote-failed',{operation,message,...details})
      throw Object.assign(new RemoteError('virtual-desktop/task-rejected', message, { operation }),{
        ...(details.reason?{reason:details.reason}:{}),...(details.nextTool?{nextTool:details.nextTool}:{}),...(details.retryAfterMs===undefined?{}:{retryAfterMs:details.retryAfterMs}),
      })
    }
  }

  /** Drain the worker before the exclusive provider is released. */
  async close(): Promise<void> {
    this.status = 'stopping'
    await this.tasks.close()
    await this.native.close()
    await this.worker.close()
    this.status = 'stopped'
  }
}
