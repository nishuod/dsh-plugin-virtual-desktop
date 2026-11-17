import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import { sameApplicationScope } from './application-lifecycle.ts'
import type { DesktopRuntimeState } from './native-contract.ts'
import { NativeTransportError } from './native-client.ts'
import type { NativeSession } from './native-session.ts'
import { resolveVmwarePath, VmAdapter, VmCommandError, vmCommandFailure, vmCommandInputSchema, type VmCommandInput } from './vm-adapter.ts'
import type { VmwareCommandResult } from './vmware-command.ts'

type VmPowerAuthorization = {
  eligible(): boolean
  approve(reason: string): Promise<(() => boolean) | undefined>
}
export type { VmPowerAuthorization }

export type VmCommandReceipt = Omit<VmwareCommandResult, 'status' | 'childSessionId'> & {
  status: VmwareCommandResult['status'] | 'needs_authorization'
  childSessionId?: number
  operationId: string
  command: VmCommandInput['command']
  degraded?: true
  nextTool?: 'desktop_open_application' | 'desktop_get_screenshot' | 'desktop_vm_command'
  nextToolArgs?: { appId: 'vmware-workstation'; operationId: string; command: 'list' }
}

type NativePort = Pick<NativeSession, 'status' | 'appCommand'>

/** Owns admission and deduplication across child reconnects in this Host instance. */
export class VmCommandService {
  private busy = false
  private readonly receipts = new Map<string, {
    key: string
    scope: DesktopRuntimeState
    receipt: Promise<VmCommandReceipt>
  }>()

  constructor(
    private readonly native: NativePort,
    private readonly adapter: VmAdapter,
    private readonly resolveApplication = resolveVmwarePath,
  ) {}

  assertIdle(): void {
    if (this.busy) throw new Error('VMware 命令仍在执行，请等待回执或停止 PiP')
  }

  async execute(value: VmCommandInput, power: VmPowerAuthorization | undefined, signal: AbortSignal,
    assertOtherOperationsIdle: () => void = () => {}): Promise<VmCommandReceipt> {
    const input = vmCommandInputSchema.parse(value)
    const started = Date.now()
    const base = { operationId: input.operationId, command: input.command }
    const refused = (code: string, message: string, vmx: string | null = null) =>
      ({ ...base, ...vmCommandFailure(code, message, vmx, Date.now() - started) })
    const needsAuthorization = (vmx: string | null = null): VmCommandReceipt => ({
      ...refused('needs_authorization', 'VM 电源操作需要本会话的完全权限，并遵守有效审批策略', vmx),
      status: 'needs_authorization',
    })

    signal.throwIfAborted()
    if (input.command !== 'list' && !power?.eligible()) return needsAuthorization()
    const scope = await this.native.status(signal)
    if (scope.backend !== 'windows-child-session' || !scope.isolated || scope.status !== 'enabled' ||
        !scope.connectionId || !scope.childSessionId || !scope.parentSessionId || scope.childSessionId === scope.parentSessionId ||
        !scope.window?.imagePath || win32.basename(scope.window.imagePath).toLowerCase() !== 'vmware.exe') {
      try { await this.resolveApplication(input.operationId) } catch (error) {
        if (error instanceof VmCommandError) return refused(error.code, error.message)
        throw error
      }
      return { ...refused('vmware-binding-required', '需要已经绑定 VMware Workstation 的已核实 PiP 连接'), nextTool: 'desktop_open_application' }
    }
    const key = JSON.stringify(input)
    const previous = this.receipts.get(input.operationId)
    if (previous) {
      if (previous.key !== key) return refused('operation-id-conflict', 'operationId 已用于不同请求')
      if (!sameApplicationScope(previous.scope, scope)) {
        return refused('authorization-changed', '原 operationId 已被使用，当前连接或目标已变化')
      }
      return await previous.receipt
    }
    this.assertIdle()
    assertOtherOperationsIdle()
    if (this.receipts.size >= 256) return refused('command-limit', '本次 Host 已达到 VMware 命令回执上限')
    this.busy = true

    const run = async (): Promise<VmCommandReceipt> => {
      let vmx: string | null = null
      let dispatched = false
      const assertScope = async () => {
        signal.throwIfAborted()
        if (!sameApplicationScope(scope, await this.native.status(signal))) {
          throw new VmCommandError('authorization-changed', '连接、许可代次或 VMware 目标已改变')
        }
      }
      try {
        const vmwarePath = await this.resolveApplication(input.operationId)
        if (win32.normalize(vmwarePath).toLowerCase() !== win32.normalize(scope.window!.imagePath!).toLowerCase()) {
          return refused('vmware-binding-mismatch', '当前绑定的进程与注册表解析出的 VMware Workstation 不一致')
        }
        if (input.vm) {
          vmx = await this.adapter.resolveVm(input.vm, async () => {
            await assertScope()
            if (!power?.eligible()) throw new VmCommandError('needs_authorization', '当前会话的完全权限已变化')
            const result = await this.native.appCommand({
              operationId: randomUUID(), command: 'list', vmwarePath, timeoutMs: this.adapter.timeout('list'),
            }, scope, signal, () => {
              if (!power?.eligible()) throw new VmCommandError('needs_authorization', '当前会话的完全权限已变化')
            })
            if (result.status !== 'confirmed') return []
            return result.evidence.vmrunList.filter(path => result.evidence.processCheck.filter(
              process => win32.normalize(process.vmxPath).toLowerCase() === win32.normalize(path).toLowerCase(),
            ).length === 1)
          })
        }
        let recheck: (() => boolean) | undefined
        if (input.command !== 'list') {
          recheck = await power?.approve('在 PiP 子会话 ' + scope.childSessionId + ' 执行 VMware ' +
            input.command + '，目标 ' + JSON.stringify(vmx) + '，绑定进程 PID ' + scope.window!.pid)
          if (!recheck) return needsAuthorization(vmx)
        }
        await assertScope()
        signal.throwIfAborted()
        if (recheck && !recheck()) return needsAuthorization(vmx)
        const request = this.adapter.request(input, vmwarePath, vmx ?? undefined)
        const result = await this.native.appCommand(request, scope, signal, () => {
          if (recheck && !recheck()) throw new VmCommandError('needs_authorization', 'VM 命令派发前授权已变化')
          dispatched = true
        })
        await assertScope()
        if (recheck && !recheck()) throw new VmCommandError('authorization-changed', 'VM 命令执行期间授权已变化')
        const receipt: VmCommandReceipt = { ...base, ...result, elapsedMs: Date.now() - started,
          fallbackAllowed: input.fallback === 'ui' && result.fallbackAllowed }
        if (result.status === 'failed' && result.fallbackAllowed && vmx && input.fallback === 'ui') {
          return { ...receipt, degraded: true, nextTool: 'desktop_get_screenshot',
            message: result.message + '。已降级到 UI 路径，下一步先取新截图，再按现有权限核对并点击。' }
        }
        if (result.status === 'unknown' && input.command !== 'list') {
          return { ...receipt, nextTool: 'desktop_vm_command',
            nextToolArgs: { appId: 'vmware-workstation', operationId: randomUUID(), command: 'list' } }
        }
        return receipt
      } catch (error) {
        if (error instanceof VmCommandError && error.code === 'needs_authorization' && !dispatched) return needsAuthorization(vmx)
        const code = error instanceof VmCommandError ? error.code : dispatched ? 'dispatch-unconfirmed' : 'vm-command-rejected'
        const detail = error instanceof Error ? error.message : 'VMware 命令异常'
        const failure = refused(code, detail.slice(0, 1000), vmx)
        if (error instanceof NativeTransportError) {
          return { ...failure, status: dispatched ? 'unknown' : 'failed', childSessionId: scope.childSessionId,
            nextTool: 'desktop_open_application' }
        }
        if (!dispatched) return failure
        return { ...failure, status: 'unknown', childSessionId: scope.childSessionId, nextTool: 'desktop_vm_command',
          nextToolArgs: { appId: 'vmware-workstation', operationId: randomUUID(), command: 'list' } }
      }
    }

    const receipt = run()
    this.receipts.set(input.operationId, { key, scope, receipt })
    try { return await receipt } finally { this.busy = false }
  }
}
