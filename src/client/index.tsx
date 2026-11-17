import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { useEffect, useState, type CSSProperties } from 'react'
import remote from '../../lib/typert.remote-client.js'
import type { DiagnosticState } from '../diagnostics.ts'
import {NativePanel} from './NativePanel.tsx'

export const name = 'virtual-desktop-client'
export const inject = ['remote', 'slots', 'layout']
const PANEL = 'virtual-desktop' as MainPanelId
const surface: CSSProperties = {
  background: '#10131d', color: '#ecedf8', height: '100%', maxHeight: 'calc(100dvh - 40px)',
  overflowY: 'auto', padding: '36px 36px 110px', fontFamily: 'system-ui, sans-serif', boxSizing: 'border-box',
}
const card: CSSProperties = { background: '#1a2030', border: '1px solid #35415d', borderRadius: 14, padding: 24, marginTop: 20 }
const button: CSSProperties = { background: '#b9bcff', color: '#141529', border: 0, padding: '10px 18px', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }

/** Mount generated Remote contracts before a child consumes the namespace. */
export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(remote)
  ctx.effect(() => unmount)
  ctx.plugin({ name: 'virtual-desktop-panel', inject: ['remote', 'remote.virtualDesktop', 'slots', 'layout'], apply(inner: Context) {
    inner.slots.inject('main', () => inner.slots.register({ name: 'main', key: PANEL }, Panel))
    inner.slots.inject('shell.overlay', () => inner.slots.register({ name: 'shell.overlay', id: 'virtual-desktop-launcher' }, () =>
      <button style={{ ...button, pointerEvents: 'auto', position: 'fixed', right: 24, bottom: 24, boxShadow: '0 4px 24px #0006' }} onClick={() => inner.layout.selectPanel(PANEL)}>虚拟桌面工具</button>))
    inner.slots.inject('shell.overlay',()=>inner.slots.register({name:'shell.overlay',id:'virtual-desktop-stop'},()=>
      <button style={{...button,pointerEvents:'auto',position:'fixed',right:24,bottom:76,background:'#f3a9b9'}} onClick={()=>void inner.remote.virtualDesktop.control('stop')}>停止桌面输入</button>))

    function Panel() {
      const [state, setState] = useState<DiagnosticState>()
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        const abort = new AbortController()
        void inner.remote.virtualDesktop.status(abort.signal).then(result => {
          if (abort.signal.aborted) return
          if (result.ok) setState(result.value)
          else setError(`${result.error.code}: ${result.error.message}`)
        })
        return () => abort.abort()
      }, [])
      async function probe() {
        setBusy(true); setError('')
        try {
          const result = await inner.remote.virtualDesktop.probe()
          if (result.ok) setState(result.value)
          else setError(`${result.error.code}: ${result.error.message}`)
        } finally { setBusy(false) }
      }
      return <section aria-label="DSH 虚拟桌面诊断" style={surface}>
        <div style={{ color: '#acb8ef', fontSize: 12, letterSpacing: 2 }}>DSH DESKTOP TOOLS / WINDOWS PREVIEW</div>
        <h1 style={{ fontSize: 30 }}>Windows 桌面工具</h1>
        <p style={{ color: '#aeb9d5' }}>选择 Windows 子会话或当前桌面，在已授权窗口中观察画面、逐步执行任务并检查结果。</p>
        <NativePanel ctx={inner}/>
        <details style={card}><summary>插件通信诊断</summary>
          <strong style={{ color: state?.status === 'ready' ? '#9de6cb' : '#d2d7ed' }}>Host 状态：{state?.status ?? '连接中'}</strong>
          <p>独立通信诊断。实际桌面会话和窗口授权显示在上方面板。</p>
          <p style={{ color: '#aeb9d5' }}>协议 v{state?.protocolVersion ?? '—'}　进程 {state?.workerPid ?? '—'}　诊断次数 {state?.probes ?? 0}</p>
          <button style={button} disabled={busy} onClick={() => void probe()}>{busy ? '等待真实反馈…' : '检查执行器通信'}</button>
          <p aria-live="polite">{state?.lastFeedback}</p>
          {error && <p role="alert" style={{ color: '#ffb8c3' }}>{error}</p>}
        </details>
        <div style={card}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>任务循环契约</h2>
          <p>观察反馈 → 整理任务与上下文 → 公开操作说明及动作 → 校验并执行 → 再次观察</p>
          <p style={{ color: '#aeb9d5' }}>finished 进入外部完成检查；只有检查通过才能完成任务。公开说明不代表完整内部计算；当前上下文整理不等同于论文中的全部记忆机制。</p>
        </div>
        <button style={{ ...button, marginTop: 24, background: '#303b56', color: '#e1e5fb' }} onClick={() => inner.layout.selectPanel(null)}>返回对话</button>
      </section>
    }
  } })
}
