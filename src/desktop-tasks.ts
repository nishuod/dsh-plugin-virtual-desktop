import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  runLoopContract, LoopMemory, type LoopEvent, type LoopPorts, type Observation,
} from './loop-contract.ts'
import { imagePoint, type DesktopBackend, type DesktopFrame, type DesktopRuntimeState } from './native-contract.ts'
import { childDelivery } from './child-delivery.ts'
import type { NativeSession } from './native-session.ts'
import { taskRequestSchema, type TaskLogEntry, type TaskRequest, type TaskRoute, type TaskSnapshot } from './task-contract.ts'
import { cancelable, type TaskJournal, type TaskPlanner } from './task-model.ts'

type Runtime = Pick<NativeSession, 'status' | 'capture' | 'execute' | 'control' | 'close'>
type Interrupt = 'pause' | 'expire' | 'stop'
type Terminal = 'completed' | 'stopped' | 'failed' | 'budget-exhausted' | 'blocked'
type Answer = 'approve' | 'reject'
type Task = {
  state: Omit<TaskSnapshot, 'step' | 'frameId'>
  request: TaskRequest
  backend: DesktopBackend
  epoch: number
  revision: number
  frame: DesktopFrame | null
  explanation: string
  memory: LoopMemory
  journal: TaskJournal
  timer?: ReturnType<typeof setTimeout>
  resolveReview?: (answer: Answer) => void
  runner?: { abort: AbortController; done: Promise<void> }
  interrupt?: Interrupt
  draining?: Promise<DesktopRuntimeState>
}

class InspectBeforeContinuing extends Error {}

const priority: Record<Interrupt, number> = { pause: 0, expire: 1, stop: 2 }

/** One task holds the selected local window until its runner and input have drained. */
export class DesktopTasks {
  private current?: Task
  private closed = false
  constructor(private readonly runtime: Runtime, private readonly planner: TaskPlanner) {}

  async routes(signal: AbortSignal): Promise<TaskRoute[]> { return await this.planner.routes(signal) }

  snapshot(): TaskSnapshot | null {
    const task = this.current
    return task ? structuredClone({
      ...task.state, step: task.memory.stepsUsed, frameId: task.frame?.id ?? null,
    }) : null
  }

  assertIdle(): void {
    if (this.closed) throw new Error('桌面任务服务正在关闭')
    if (this.current?.state.active) throw new Error('当前任务正在使用此窗口，请先终止任务')
  }

  async start(raw: unknown, signal: AbortSignal): Promise<TaskSnapshot> {
    this.assertIdle()
    const request = taskRequestSchema.parse(raw)
    if (request.valueCheck) {
      request.acceptance = `控件「${request.valueCheck.label}」的值精确等于 ${JSON.stringify(request.valueCheck.expected)}`
    }
    await this.planner.check(request.route, signal)
    const runtime = await this.runtime.status(signal)
    signal.throwIfAborted()
    this.assertIdle()
    if (runtime.status !== 'enabled' || runtime.window?.id !== request.windowId || runtime.epoch !== request.epoch) {
      throw new Error('请重新选择并授权任务窗口')
    }
    // Older callers may request foreground; PiP always narrows this to its fixed background route.
    if (runtime.backend === 'windows-child-session') request.delivery = 'background'
    if (request.delivery === 'foreground' && !runtime.foregroundAllowed) {
      throw new Error('请在窗口授权中明确允许前台输入')
    }
    const id = randomUUID()
    const deadlineAt = Date.now() + request.timeoutSeconds * 1000
    const task: Task = {
      request, backend: runtime.backend, epoch: runtime.epoch, revision: 0, frame: null, explanation: '',
      memory: new LoopMemory(), journal: this.planner.journal(id),
      state: {
        id, active: true, status: 'observing', goal: request.goal, acceptance: request.acceptance,
        windowTitle: runtime.window.title, provider: request.route.provider, model: request.route.model,
        maxSteps: request.maxSteps, deadlineAt, review: null, logs: [],
      },
    }
    try {
      this.note(task, 'start', `任务已绑定 ${runtime.window.title}，最多 ${request.maxSteps} 步，时限 ${request.timeoutSeconds} 秒。`)
    } catch (error) {
      await task.journal.close().catch(() => {})
      throw error
    }
    this.current = task
    task.timer = setTimeout(() => {
      if (task.state.active) void this.interrupt(task, 'expire').catch(() => {})
    }, request.timeoutSeconds * 1000).unref()
    this.launch(task)
    return this.snapshot()!
  }

  frame(taskId: string, frameId: string): DesktopFrame {
    const task = this.current
    if (!task || task.state.id !== taskId || !task.frame || task.frame.id !== frameId) {
      throw new Error('观察已更新，请读取最新任务画面')
    }
    return task.frame
  }

  answer(taskId: string, reviewId: string, answer: Answer): TaskSnapshot {
    const task = this.current
    if (!task || task.state.id !== taskId || task.state.review?.id !== reviewId
      || !task.resolveReview || task.interrupt || Date.now() >= task.state.deadlineAt) {
      throw new Error('此确认已失效，请查看最新任务状态')
    }
    const resolve = task.resolveReview
    task.state.review = null
    task.resolveReview = undefined
    resolve(answer)
    return this.snapshot()!
  }

  async control(command: 'pause' | 'resume' | 'stop', signal: AbortSignal): Promise<DesktopRuntimeState> {
    signal.throwIfAborted()
    const task = this.current
    if (!task?.state.active) return await this.runtime.control(command, signal)
    if (command !== 'resume') return await this.interrupt(task, command)
    if (task.state.status !== 'paused' || task.draining) throw new Error('等待任务暂停后再继续')
    if (Date.now() >= task.state.deadlineAt) return await this.interrupt(task, 'expire')
    task.state.status = 'resuming'
    try {
      const runtime = await this.runtime.control('resume', AbortSignal.timeout(31000))
      if (task.draining) return await task.draining
      if (!task.state.active || task.state.status !== 'resuming') return await this.runtime.status(signal)
      if (runtime.window?.id !== task.request.windowId || runtime.status !== 'enabled') {
        throw new Error('原任务窗口已失效，请终止后重新授权')
      }
      task.epoch = runtime.epoch
      this.note(task, 'control', '继续任务，从新截图重新规划。')
      this.launch(task)
      return runtime
    } catch (error) {
      if (task.state.status === 'resuming') task.state.status = 'paused'
      throw error
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.current?.state.active) await this.interrupt(this.current, 'stop').catch(() => {})
  }

  disconnect(): void {
    const task = this.current
    if (task?.state.active) {
      task.frame = null
      void this.interrupt(task, 'stop').catch(() => {})
    }
  }

  private launch(task: Task): void {
    const abort = new AbortController()
    const done = this.run(task, abort.signal)
    task.runner = { abort, done }
  }

  private async run(task: Task, signal: AbortSignal): Promise<void> {
    let hold: string | undefined
    const ports: LoopPorts = {
      observe: async (_signal, purpose) => {
        task.state.status = purpose === 'evaluate' ? 'verifying' : 'observing'
        if (purpose === 'after-action') await delay(250, undefined, { signal })
        const frame = await this.capture(task, signal, purpose === 'evaluate')
        return { revision: ++task.revision, feedback: frame.tree.slice(0, 1000) || '收到窗口截图' }
      },
      decide: async context => {
        task.state.status = 'planning'
        return await cancelable(this.planner.decide(task.state.id, task.request, context, task.frame!, signal, task.backend), signal)
      },
      rejectDecision: message => this.note(task, 'error', message),
      record: async event => this.record(task, event),
      execute: async (action, revision) => {
        if (revision !== task.revision) throw new Error('动作引用的观察已过期')
        const frame = task.frame!
        try {
          imagePoint(action.x, action.y, frame, { x: 0, y: 0, width: frame.width, height: frame.height })
          if (action.type === 'drag') {
            imagePoint(action.toX, action.toY, frame, { x: 0, y: 0, width: frame.width, height: frame.height })
          }
        } catch {
          return '动作坐标超出截图，未发送输入'
        }
        let delivery = task.request.delivery
        if (task.backend === 'windows-child-session') {
          try { delivery = childDelivery(action) } catch (error) {
            return error instanceof Error ? error.message : '画中画试验版拒绝该动作'
          }
        }
        const detail = JSON.stringify({ delivery, ...action }, null, 2)
        const approved = await this.ask(task, 'input', frame, detail, task.explanation, signal)
        if (!approved) {
          hold = '用户拒绝本次输入，任务已暂停。'
          return '用户拒绝，未发送输入'
        }
        task.state.status = 'executing'
        const fresh = await this.capture(task, signal)
        if (!sameContent(frame, fresh)) return '确认期间画面变化，请依据新截图重新规划'
        const operationId = randomUUID()
        this.note(task, 'dispatch', `${operationId} · ${action.type} (${Math.round(action.x)}, ${Math.round(action.y)}) · 观察 ${fresh.id}`)
        this.checkRunning(task, signal)
        try {
          // Control uses a separate IPC call that closes admission and drains
          // the worker. Canceling this RPC would close the channel itself.
          const receipt = await this.runtime.execute({
            operationId, frameId: fresh.id, epoch: fresh.epoch, delivery, action,
          }, AbortSignal.timeout(31000))
          if (receipt.outcome === 'unknown') hold = '执行结果待核对，已暂停任务。'
          const feedback = receipt.outcome === 'delivered' ? '执行器已发送输入，请检查新的观察' : receipt.message
          if (signal.aborted) this.note(task, 'result', feedback)
          return feedback
        } catch {
          hold = '执行通道异常，已暂停任务。请核对窗口状态。'
          return '执行结果未知'
        }
      },
      afterAction: () => { if (hold) throw new InspectBeforeContinuing(hold) },
      evaluate: async context => this.evaluate(task, context.observation, signal),
    }
    try {
      const result = await runLoopContract(task.request.goal, task.request.acceptance, ports,
        { steps: task.request.maxSteps, recent: 3, summary: 6 }, signal, task.memory)
      if (task.interrupt) return
      const message = result === 'completed' ? '独立验收通过。'
        : result === 'blocked' ? '模型报告当前窗口中的任务受阻。' : '已用完模型步骤预算。'
      await this.finish(task, result, message)
    } catch (error) {
      if (task.interrupt || signal.aborted) return
      if (Date.now() >= task.state.deadlineAt) {
        queueMicrotask(() => { void this.interrupt(task, 'expire').catch(() => {}) })
        return
      }
      if (error instanceof InspectBeforeContinuing) {
        try {
          this.note(task, 'control', error.message)
        } catch {
          await this.finish(task, 'failed', '任务记录写入失败')
          return
        }
        queueMicrotask(() => { void this.interrupt(task, 'pause').catch(() => {}) })
        return
      }
      const message = error instanceof Error ? error.message.slice(0, 450) : '任务运行失败'
      await this.finish(task, 'failed', message)
    }
  }

  private checkRunning(task: Task, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (task.interrupt || Date.now() >= task.state.deadlineAt) throw new Error('任务许可已过期')
  }

  private async capture(task: Task, signal: AbortSignal, evaluate = false): Promise<DesktopFrame> {
    this.checkRunning(task, signal)
    const frame = await this.runtime.capture('window', undefined, AbortSignal.timeout(31000),
      evaluate ? task.request.valueCheck : undefined)
    this.checkRunning(task, signal)
    if (frame.source !== 'window' || frame.windowId !== task.request.windowId || frame.epoch !== task.epoch
      || frame.id === task.frame?.id) throw new Error('执行器没有返回绑定窗口的新截图')
    task.frame = frame
    return frame
  }

  private async evaluate(task: Task, observation: Observation, signal: AbortSignal) {
    const frame = task.frame!
    const revision = observation.revision
    const evidence = `截图 ${frame.id}`
    if (frame.valueCheck === 'match') {
      return { verdict: 'pass' as const, revision, evidence: `${evidence} 的目标控件值精确匹配` }
    }
    if (frame.valueCheck === 'mismatch') {
      return { verdict: 'fail' as const, revision, evidence: `${evidence} 的目标控件值尚未匹配` }
    }
    const detail = frame.valueCheck === 'unavailable'
      ? `控件读回不可用，请根据新截图检查：${task.request.acceptance}`
      : task.request.acceptance
    if (!await this.ask(task, 'verification', frame, detail, task.explanation, signal)) {
      return { verdict: 'fail' as const, revision, evidence: `用户检查了 ${evidence}，验收未通过` }
    }
    task.state.status = 'verifying'
    const current = await this.capture(task, signal, true)
    if (!sameContent(frame, current) || current.valueCheck === 'mismatch') {
      return { verdict: 'inconclusive' as const, revision, evidence: `验收期间窗口变化，需要重新检查 ${current.id}` }
    }
    return { verdict: 'pass' as const, revision, evidence: `用户确认 ${evidence}，复查 ${current.id} 一致` }
  }

  private async ask(task: Task, kind: 'input' | 'verification', frame: DesktopFrame, detail: string,
    explanation: string, signal: AbortSignal): Promise<boolean> {
    this.checkRunning(task, signal)
    this.note(task, 'approval', kind === 'input' ? '等待逐次输入批准。' : '等待独立人工验收。')
    task.state.status = kind === 'input' ? 'awaiting-approval' : 'awaiting-verification'
    task.state.review = { id: randomUUID(), kind, frameId: frame.id, detail, explanation }
    try {
      const answer = await cancelable(new Promise<Answer>(resolve => { task.resolveReview = resolve }), signal)
      this.checkRunning(task, signal)
      this.note(task, 'approval', answer === 'approve' ? '收到本次确认。' : '用户拒绝本次请求。')
      return answer === 'approve'
    } finally {
      task.state.review = null
      task.resolveReview = undefined
    }
  }

  private record(task: Task, event: LoopEvent): void {
    switch (event.type) {
      case 'observed':
        this.note(task, 'observed', `观察 #${event.observation.revision} · ${task.frame!.id}`)
        break
      case 'context':
        break
      case 'decision':
        task.explanation = event.decision.explanation
        this.note(task, 'model', `${event.decision.kind} · ${task.explanation}`)
        break
      case 'receipt':
        this.note(task, 'result', event.receipt)
        break
      case 'evaluation':
        this.note(task, 'evaluation', `${event.verdict} · ${event.evidence}`)
        break
    }
  }

  private note(task: Task, kind: TaskLogEntry['kind'], message: string): void {
    const entry = { time: Date.now(), step: task.memory.stepsUsed, kind, message: message.slice(0, 800) }
    task.journal.append(entry)
    task.state.logs.push(entry)
    if (task.state.logs.length > 80) task.state.logs.shift()
  }

  private async interrupt(task: Task, intent: Interrupt): Promise<DesktopRuntimeState> {
    if (!task.interrupt || priority[intent] > priority[task.interrupt]) task.interrupt = intent
    task.state.status = task.interrupt === 'pause' ? 'pausing' : 'stopping'
    task.state.review = null
    task.runner?.abort.abort()
    if (task.draining) return await task.draining
    task.draining = this.drain(task)
    try { return await task.draining } finally {
      task.draining = undefined
      task.interrupt = undefined
    }
  }

  private async drain(task: Task): Promise<DesktopRuntimeState> {
    try {
      const signal = AbortSignal.timeout(31000)
      let runtime = await this.runtime.control(task.interrupt === 'pause' ? 'pause' : 'stop', signal)
      await task.runner?.done
      if (task.interrupt !== 'pause' && runtime.status !== 'stopped') {
        runtime = await this.runtime.control('stop', AbortSignal.timeout(31000))
      }
      if (task.interrupt === 'pause') {
        if (runtime.status !== 'paused') throw new Error('执行器未确认暂停')
        this.note(task, 'control', '执行器已排空，任务暂停。')
        task.state.status = 'paused'
      } else {
        if (runtime.status !== 'stopped') throw new Error('执行器未确认终止')
        await this.finish(task, task.interrupt === 'expire' ? 'budget-exhausted' : 'stopped',
          task.interrupt === 'expire' ? '任务已达到时间上限，执行器已停止。' : '执行器已排空，任务终止。')
      }
      return runtime
    } catch (error) {
      try { await this.runtime.close() } finally {
        await task.runner?.done
        await this.finish(task, 'failed', '执行器控制通道异常，授权已撤销。请调用 desktop_reset_child_session 核实清理状态。')
      }
      throw error
    }
  }

  private async finish(task: Task, status: Terminal, message: string): Promise<void> {
    clearTimeout(task.timer)
    task.state.review = null
    if (status === 'stopped') task.frame = null
    try {
      this.note(task, 'control', message)
    } catch {
      status = 'failed'
      task.state.logs.push({ time: Date.now(), step: task.memory.stepsUsed, kind: 'error', message: '任务记录写入失败' })
    }
    task.state.active = false
    task.state.status = status
    try {
      await task.journal.close()
    } catch {
      task.state.logs.push({ time: Date.now(), step: task.memory.stepsUsed, kind: 'error', message: '任务日志未能确认持久化' })
    }
  }
}

function sameContent(before: DesktopFrame, after: DesktopFrame): boolean {
  return before.width === after.width && before.height === after.height
    && before.data === after.data && before.tree === after.tree
}
