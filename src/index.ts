import type { PrivacyOptions } from './privacy.ts'
import type { VisualOptions } from './visual-targets.ts'
import { redactDiagnostics } from './redaction.ts'
import { platformSupport } from './platform.ts'
import { pluginBuild } from './build-identity.ts'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import type {} from '@deepseek-ai/dsh-computer-use'
import { DiagnosticWorker } from './worker-client.ts'
import { VirtualDesktopController } from './controller.ts'
import { registerNativeTools } from './native-tools.ts'
import { NativeSession } from './native-session.ts'
import { DesktopTasks } from './desktop-tasks.ts'
import { DshTaskPlanner } from './task-model.ts'
import { describeDesktopConnection, desktopGuidance, pipProfile } from './desktop-guidance.ts'
import { resolveChildStartPermission, sessionApprovalPolicy } from './child-start-permission.ts'
import type { VmAdapterOptions, VmInventoryEntry } from './vm-adapter.ts'
export { VirtualDesktopController } from './controller.ts'
export type { DiagnosticState } from './diagnostics.ts'

export const name = 'virtual-desktop'
export const inject = ['tools', 'computerUse']
export interface Config extends Omit<VmAdapterOptions, 'vmAllowedRoots' | 'vmInventory'> {
  workerTimeoutMs: number
  nativeTimeoutMs: number
  frameAgeMs: number
  screenshotMaxDimension: number
  screenshotMaxBytes: number
  privacy?: PrivacyOptions
  visualCandidates?: VisualOptions
  experimentalTasks?: boolean
  vmAllowedRoots?: string[]
  vmInventory?: VmInventoryEntry[]
}
export const Config: Schema<Config> = Schema.object({
  workerTimeoutMs: Schema.number().min(100).max(30_000).step(1).default(5000).description('诊断 worker 响应期限（毫秒）'),
  nativeTimeoutMs:Schema.number().min(5000).max(30000).step(1).default(15000).description('本机执行器响应期限（毫秒）'),
  frameAgeMs:Schema.number().min(1000).max(120000).step(1).default(60000).description('可操作截图的最大年龄（毫秒）'),
  screenshotMaxDimension:Schema.number().min(320).max(1920).step(1).default(1280).description('截图长边上限'),
  screenshotMaxBytes:Schema.number().min(32000).max(512000).step(1).default(512000).description('JPEG 截图字节上限'),
  experimentalTasks:Schema.boolean().default(false).description('启用 experimental 视觉自主任务；默认关闭'),
  visualCandidates:Schema.object({
    enabled:Schema.boolean().default(true),
    maxCandidates:Schema.number().min(1).max(8).step(1).default(8),
    budgetMs:Schema.number().min(1).max(120).step(1).default(120),
    minRegionHeightPx:Schema.number().min(24).max(256).step(1).default(32).description('候选在 JPEG 中的最小高度'),
    maxRegionAspectRatio:Schema.number().min(1).max(32).default(8).description('候选在 JPEG 中的最大宽高比'),
  }).default({enabled:true,maxCandidates:8,budgetMs:120,minRegionHeightPx:32,maxRegionAspectRatio:8})
    .description('已授权客户区的本地视觉候选；超时丢弃，不赋予输入授权'),
  privacy:Schema.object({
    excludedRectangles:Schema.array(Schema.object({x:Schema.number().required(),y:Schema.number().required(),width:Schema.number().min(1).required(),height:Schema.number().min(1).required()})).max(64).default([]).description('物理屏幕坐标中必须遮蔽的矩形'),
    windowTitleBlacklist:Schema.array(Schema.string()).max(64).default([]).description('窗口标题包含任一字符串时遮蔽整帧，不区分大小写'),
  }).default({excludedRectangles:[],windowTitleBlacklist:[]}),
  vmAllowedRoots:Schema.array(Schema.string()).max(32).default([]).description('VMware 电源命令允许的本地 VMX 根目录'),
  vmInventory:Schema.array(Schema.object({ name:Schema.string().required(), vmx:Schema.string().required() })).max(128)
    .default([]).description('用户显式登记的 VMware 虚拟机名称和绝对 VMX 路径'),
  vmStartTimeoutMs:Schema.number().min(30_000).max(180_000).step(1).default(90_000).description('VMware start 总超时（毫秒）'),
  vmStopTimeoutMs:Schema.number().min(15_000).max(60_000).step(1).default(30_000).description('VMware stop 总超时（毫秒）'),
})

/** Native input stays disabled until the owner explicitly enables and selects a target. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const worker = new DiagnosticWorker(config.workerTimeoutMs)
  const native = new NativeSession({
    timeoutMs: config.nativeTimeoutMs, frameAgeMs: config.frameAgeMs,
    maxDimension: config.screenshotMaxDimension, imageBytes: config.screenshotMaxBytes, privacy:config.privacy,visualCandidates:config.visualCandidates,
  }, () => tasks.disconnect())
  const tasks = new DesktopTasks(native, new DshTaskPlanner(ctx))
  const service = new VirtualDesktopController(ctx, worker, native, tasks, config)
  const lifetime = new AbortController()
  ctx.on('internal/plugin', fiber => {
    if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort()
  }, { global: true })
  let ready: Promise<void> = Promise.resolve()
  const dispose = ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('dsh-virtual-desktop-phase2'))
    yield async () => { lifetime.abort(); await ready.catch(() => {}); await service.close() }
    const child = ctx.plugin({ name: 'virtual-desktop-runtime', inject: ['tools'], apply: mount })
    yield child.dispose
    ready = Promise.resolve(child).then(() => {})
  }, 'virtual-desktop.runtime')
  try { await ready } catch (error) { await dispose(); throw error }

  async function mount(inner: Context): Promise<void> {
    await service.initialize(lifetime.signal)
    registerNativeTools(inner,service)
    inner.tools.register(defineTool({
      name: 'desktop_get_diagnostics',
      description: '读取真实连接、启动权限和下一步指引。plugin 标识当前包版本、构建哈希和构建时间（已注入时）。desktop.activeBackend 是当前已连接后端，未连接为 null；desktop.backend 是保留的执行器模式。desktop.capabilities 报告当前连接可用的截图能力，pipProfile 描述聊天打开 PiP 后支持的能力。desktop.pipDisplay 分别报告建连请求和 WTS 实测的子会话分辨率。未连接也能调用。',
      parameters: {},
      output: {
        schema: { type: 'object', properties: {
          plugin: { type: 'object', properties: {
            version: { type: 'string', required: true },
            buildHash: { type: 'string', required: true },
            builtAt: { type: 'string', required: true },
          }, additionalProperties: false },
          diagnosticChannel: { type: 'object', additionalProperties: true },
          platform: {type:'object',additionalProperties:true},
          desktop: { type: 'object', properties: {
            activeBackend: { oneOf: [{ type: 'string', enum: ['windows-attended', 'windows-child-session'] }, { type: 'null' }], required: true },
          }, additionalProperties: true },
          pipProfile: { type: 'object', properties: {
            backend: { type: 'string', const: 'windows-child-session', required: true },
            isolated: { type: 'boolean', const: true, required: true },
            capabilities: { type: 'object', required: true, additionalProperties: true },
          }, additionalProperties: false },
          childStartPermission: { type: 'string', enum: ['ask', 'session-grant', 'blocked'] },
          nextTool: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          guidance: { type: 'string' }, completionPolicy: { type: 'string' },
        }, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        const desktop = await service.desktopStatus(exec.signal)
        const { window, windowDiscovery, ...connection } = describeDesktopConnection(desktop)
        const childStartPermission = resolveChildStartPermission(inner, exec.agent)
        return redactDiagnostics({ ...(pluginBuild ? { plugin: pluginBuild } : {}), platform:{...platformSupport()}, diagnosticChannel: { ...service.snapshot() }, desktop: {
          ...connection,
          window: window ? { ...window } : null,
          ...(windowDiscovery ? { windowDiscovery: { ...windowDiscovery, filtered: { ...windowDiscovery.filtered } } } : {}),
        },
          pipProfile, childStartPermission, ...desktopGuidance(desktop, childStartPermission, sessionApprovalPolicy(inner, exec.agent) === 'never'),
          completionPolicy: 'external-evaluator-required' })
      },
    }))
  }
}
