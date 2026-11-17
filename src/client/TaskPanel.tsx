import { useEffect, useState, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { DesktopFrame, DesktopRuntimeState, TaskRoute, TaskSnapshot } from '../diagnostics.ts'
import type {} from '../../lib/typert.remote-client.js'

const field: CSSProperties = {
  background: '#0e1422', color: '#edf0ff', border: '1px solid #4b5874',
  borderRadius: 7, padding: 9, boxSizing: 'border-box', maxWidth: '100%',
}
const button: CSSProperties = {
  background: '#b9bcff', color: '#141529', border: 0, padding: '9px 13px',
  borderRadius: 8, fontWeight: 600, cursor: 'pointer',
}
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 12 }
const phases: Record<TaskSnapshot['status'], string> = {
  observing: '观察窗口', planning: '模型规划中', 'awaiting-approval': '等待输入批准',
  executing: '执行本步', verifying: '复查任务结果', 'awaiting-verification': '等待人工验收',
  pausing: '正在暂停', paused: '已暂停', resuming: '正在继续', stopping: '正在终止',
  stopped: '已终止', completed: '验收通过', failed: '任务失败', 'budget-exhausted': '已达任务上限', blocked: '任务受阻',
}

export function TaskPanel({ ctx, runtime, runtimeVerified, childMode, onActiveChange }: {
  ctx: Context
  runtime: DesktopRuntimeState | undefined
  runtimeVerified: boolean
  childMode: boolean
  onActiveChange: (active: boolean) => void
}) {
  const remote = ctx.remote.virtualDesktop
  const [task, setTask] = useState<TaskSnapshot | null>(null)
  const [routes, setRoutes] = useState<TaskRoute[]>([])
  const [routeIndex, setRouteIndex] = useState('')
  const [goal, setGoal] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [exact, setExact] = useState(false)
  const [label, setLabel] = useState('')
  const [expected, setExpected] = useState('')
  const [delivery, setDelivery] = useState<'background' | 'foreground'>('background')
  const [maxSteps, setMaxSteps] = useState(10)
  const [timeoutSeconds, setTimeoutSeconds] = useState(180)
  const [frame, setFrame] = useState<DesktopFrame>()
  const [loadedFrame, setLoadedFrame] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const taskDelivery = childMode ? 'background' : delivery

  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const result = await remote.taskStatus(abort.signal)
        if (!abort.signal.aborted && result.ok) setTask(result.value)
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void refresh().catch(() => {}), 750)
      }
    }
    void refresh().catch(() => {})
    return () => { abort.abort(); clearTimeout(timer) }
  }, [ctx])

  useEffect(() => { onActiveChange(Boolean(task?.active)) }, [task?.active, onActiveChange])
  const taskId = task?.id
  const frameId = task?.frameId
  useEffect(() => {
    setFrame(undefined)
    setLoadedFrame('')
    if (!taskId || !frameId) return
    const abort = new AbortController()
    void remote.taskFrame(taskId, frameId, abort.signal).then(result => {
      if (!abort.signal.aborted && result.ok) setFrame(result.value)
    }).catch(() => {})
    return () => abort.abort()
  }, [ctx, taskId, frameId])

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    try { await work() }
    catch (error) { setError(error instanceof Error ? error.message : '请求失败') }
    finally { setBusy(false) }
  }

  async function refreshRoutes() {
    await run(async () => {
      const result = await remote.taskRoutes()
      if (!result.ok) throw new Error(result.error.message)
      setRoutes(result.value)
      setRouteIndex(result.value.length === 1 ? '0' : '')
      if (!result.value.length) setError('DSH 当前没有列出支持图像的模型，请检查模型配置。')
    })
  }

  async function start() {
    const route = routes[Number(routeIndex)]
    if (!runtimeVerified || runtime?.status !== 'enabled' || !runtime.window || routeIndex === '' || !route) return
    await run(async () => {
      const result = await remote.startTask(JSON.stringify({
        goal, acceptance: exact ? '读取目标控件的完整值' : acceptance,
        route: { provider: route.provider, model: route.model },
        windowId: runtime.window!.id, epoch: runtime.epoch,
        maxSteps, timeoutSeconds, delivery: taskDelivery,
        ...(exact ? { valueCheck: { label, expected } } : {}),
      }))
      if (!result.ok) throw new Error(result.error.message)
      setTask(result.value)
    })
  }

  async function answer(value: 'approve' | 'reject') {
    if (!task?.review || loadedFrame !== task.review.frameId
      || (value === 'approve' && (!runtimeVerified || runtime?.status !== 'enabled'))) return
    await run(async () => {
      const result = await remote.answerTask(task.id, task.review!.id, value)
      if (!result.ok) throw new Error(result.error.message)
      setTask(result.value)
    })
  }

  async function control(command: 'pause' | 'resume' | 'stop') {
    setError('')
    const result = await remote.control(command)
    if (!result.ok) setError(result.error.message)
  }

  const canStart = runtimeVerified && runtime?.status === 'enabled' && goal.trim() && (exact ? label.trim() : acceptance.trim())
    && routeIndex !== '' && Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 24
    && Number.isInteger(timeoutSeconds) && timeoutSeconds >= 30 && timeoutSeconds <= 600
    && (taskDelivery === 'background' || runtime.foregroundAllowed)
  const review = task?.review
  return <section aria-label="桌面任务" style={{ background: '#1a2030', border: '1px solid #605c89', borderRadius: 14, padding: 22, marginTop: 18 }}>
    <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>桌面任务</h2>
    <p style={{ color: '#c4cbe1', fontSize: 13 }}>任务使用当前授权窗口。截图会发给所选模型并保存在 DSH 附件中。每步输入都要在这里批准。</p>
    {childMode && <p style={{ color: '#c4cbe1', fontSize: 13 }}>PiP 模式在已核实的子会话中执行任务。每步审阅会显示执行器采用的投递方式。</p>}
    {!task?.active && <>
      <label style={{ display: 'block' }}>任务目标
        <textarea style={{ ...field, display: 'block', width: '100%', marginTop: 5 }} rows={2}
          placeholder="例如，在测试窗口的输入框中写入一段中文" maxLength={1500} value={goal} onChange={event => setGoal(event.target.value)} />
      </label>
      <label style={{ display: 'block', marginTop: 10 }}>
        <input type="checkbox" checked={exact} onChange={event => setExact(event.target.checked)} /> 用控件值精确验收
      </label>
      {exact ? <div style={row}>
        <input aria-label="无障碍控件名称" placeholder="无障碍控件名称" style={field} maxLength={200} value={label} onChange={event => setLabel(event.target.value)} />
        <input aria-label="预期完整值" placeholder="预期完整值" style={{ ...field, flex: 1 }} maxLength={2000} value={expected} onChange={event => setExpected(event.target.value)} />
      </div> : <label style={{ display: 'block', marginTop: 8 }}>验收条件
        <input style={{ ...field, display: 'block', width: '100%', marginTop: 5 }} maxLength={600} value={acceptance} onChange={event => setAcceptance(event.target.value)} />
      </label>}
      <div style={row}>
        <button style={button} disabled={busy} onClick={() => void refreshRoutes()}>读取图像模型</button>
        <select aria-label="任务模型" style={field} value={routeIndex} onChange={event => setRouteIndex(event.target.value)}>
          <option value="">选择 DSH 图像模型</option>
          {routes.map((route, index) => <option key={`${route.provider}:${route.model}`} value={index}>{route.label} · {route.provider}</option>)}
        </select>
        {!childMode && <select aria-label="任务输入方式" style={field} value={delivery} onChange={event => setDelivery(event.target.value as typeof delivery)}>
          <option value="background">后台输入</option>
          <option value="foreground" disabled={!runtime?.foregroundAllowed}>前台输入</option>
        </select>}
      </div>
      <div style={row}>
        <label>步数上限 <input type="number" min={1} max={24} style={{ ...field, width: 70 }} value={maxSteps} onChange={event => setMaxSteps(Number(event.target.value))} /></label>
        <label>时限（秒） <input type="number" min={30} max={600} style={{ ...field, width: 85 }} value={timeoutSeconds} onChange={event => setTimeoutSeconds(Number(event.target.value))} /></label>
        <button style={button} disabled={busy || !canStart} onClick={() => void start()}>开始任务</button>
      </div>
    </>}
    {task && <>
      <div style={row} aria-live="polite">
        <strong>{phases[task.status]} · {task.step}/{task.maxSteps} 步</strong>
        <span style={{ color: '#aeb9d5' }}>{task.windowTitle} · {task.model}</span>
        {task.active && <>
          <button style={button} disabled={['pausing', 'stopping', 'resuming'].includes(task.status)}
            onClick={() => void control(task.status === 'paused' ? 'resume' : 'pause').catch(() => setError('控制请求失败'))}>{task.status === 'paused' ? '继续任务' : '暂停任务'}</button>
          <button style={{ ...button, background: '#f3a9b9' }} onClick={() => void control('stop').catch(() => setError('终止请求失败'))}>终止任务</button>
        </>}
      </div>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{task.goal}</p>
      {frame && <img key={frame.id} alt="任务的最新窗口截图"
        src={`data:${frame.mimeType};base64,${frame.data}`} onLoad={() => setLoadedFrame(frame.id)}
        style={{ display: 'block', width: 'auto', maxWidth: '100%', maxHeight: 350, objectFit: 'contain', border: '1px solid #465371' }} />}
      {review && <div style={{ marginTop: 12, background: '#232945', padding: 14, borderRadius: 8 }}>
        <strong>{review.kind === 'input' ? '核对本次输入' : '根据截图独立验收'}</strong>
        <p style={{ overflowWrap: 'anywhere' }}>{review.explanation}</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.detail}</pre>
        <div style={row}>
          <button style={button} disabled={busy || !runtimeVerified || runtime?.status !== 'enabled' || loadedFrame !== review.frameId} onClick={() => void answer('approve')}>
            {review.kind === 'input' ? '批准这一步输入' : '确认验收通过'}
          </button>
          <button style={{ ...button, background: '#e7c0cd' }} disabled={busy || loadedFrame !== review.frameId} onClick={() => void answer('reject')}>
            {review.kind === 'input' ? '拒绝并暂停' : '尚未达到验收条件'}
          </button>
        </div>
      </div>}
      <details open style={{ marginTop: 14 }}>
        <summary>执行记录</summary>
        <ol style={{ fontSize: 12, color: '#c4cbe1', maxHeight: 230, overflow: 'auto', paddingLeft: 24 }}>
          {task.logs.slice().reverse().map((entry, index) => <li key={`${entry.time}-${index}`} style={{ padding: '3px 0', overflowWrap: 'anywhere' }}>
            {new Date(entry.time).toLocaleTimeString()} · 第 {entry.step} 步 · {entry.message}
          </li>)}
        </ol>
      </details>
    </>}
    {error && <p role="alert" style={{ color: '#ffb8c3' }}>{error}</p>}
  </section>
}
