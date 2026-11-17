import { open, realpath, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { z } from 'zod'
import { resolveApplication } from './application-catalog.ts'
import { vmwareCommandNameSchema, type VmwareCommandRequest, type VmwareCommandResult } from './vmware-command.ts'

export interface VmInventoryEntry {
  name: string
  vmx: string
}

export interface VmAdapterOptions {
  vmAllowedRoots?: readonly string[]
  vmInventory?: readonly VmInventoryEntry[]
  vmStartTimeoutMs?: number
  vmStopTimeoutMs?: number
}

export class VmCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'VmCommandError'
  }
}

export const vmCommandInputSchema = z.strictObject({
  appId: z.literal('vmware-workstation'),
  operationId: z.uuid(),
  vm: z.string().trim().min(1).max(1024).optional(),
  command: vmwareCommandNameSchema,
  fallback: z.literal('ui').optional(),
}).superRefine((input, ctx) => {
  if (input.command === 'list' ? input.vm !== undefined : !input.vm) {
    ctx.addIssue({ code: 'custom', path: ['vm'], message: 'list 不传 vm，电源命令必须指定一个登记的 VM' })
  }
})

export type VmCommandInput = z.infer<typeof vmCommandInputSchema>

export function localVmPath(path: string, requireVmx = true): string {
  const tail = path.slice(3)
  if (path.length > 1024 || !/^[a-z]:[\\/]/i.test(path) ||
      /[\x00-\x1f\x7f"<>|?*:]/.test(tail) ||
      tail.split(/[\\/]/).some(part => part === '.' || part === '..' || /[. ]$/.test(part)) ||
      (requireVmx && win32.extname(path).toLowerCase() !== '.vmx')) {
    throw new VmCommandError('vmx-invalid-path', '需要本地绝对 .vmx 路径，不支持 UNC、设备路径、.. 或附加参数')
  }
  return win32.normalize(path)
}

const pathKey = (path: string) => win32.normalize(path).toLowerCase()

export function insideVmRoot(path: string, root: string): boolean {
  const relative = win32.relative(pathKey(root), pathKey(path))
  return relative !== '' && relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative)
}

/** Recognize only the Workstation inventory and MRU path fields, never arbitrary .vmx values. */
export function parseVmInventory(text: string): VmInventoryEntry[] {
  const entries = new Map<string, Partial<VmInventoryEntry>>()
  for (const line of text.split(/\r?\n/)) {
    const field = /^\s*(vmlist\d+)\.(config|displayname)\s*=\s*"([^"\r\n]*)"\s*$/i.exec(line)
      ?? /^\s*(pref\.mruvm\d+)\.(filename|displayname)\s*=\s*"([^"\r\n]*)"\s*$/i.exec(line)
    if (!field) continue
    const [, id, property, value] = field
    const key = id.toLowerCase()
    const entry = entries.get(key) ?? {}
    if (property.toLowerCase() === 'displayname') entry.name = value
    else entry.vmx = value
    entries.set(key, entry)
  }
  return [...entries.values()].flatMap(entry => {
    if (!entry.vmx) return []
    try {
      const vmx = localVmPath(entry.vmx)
      return [{ name: entry.name || win32.basename(vmx, win32.extname(vmx)), vmx }]
    } catch {
      return []
    }
  })
}

async function readVmwareInventory(): Promise<VmInventoryEntry[]> {
  const profile = process.env.APPDATA
  if (!profile) return []
  try { localVmPath(profile, false) } catch { return [] }
  const result: VmInventoryEntry[] = []
  for (const name of ['inventory.vmls', 'preferences.ini']) {
    const file = await open(win32.join(profile, 'VMware', name), 'r').catch(() => undefined)
    if (!file) continue
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 512_000) continue
      const bytes = Buffer.alloc(info.size)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
      result.push(...parseVmInventory(text))
    } catch { /* Unreadable Workstation inventory contributes no entries. */ }
    finally { await file.close() }
  }
  return result
}

export function vmrunArguments(command: VmCommandInput['command'], vmx?: string): string[] {
  vmwareCommandNameSchema.parse(command)
  if (command === 'list') {
    if (vmx !== undefined) throw new VmCommandError('vmx-invalid-path', 'list 不接受 VMX 参数')
    return ['-T', 'ws', 'list']
  }
  if (!vmx) throw new VmCommandError('vmx-invalid-path', '缺少 VMX 路径')
  const argv = ['-T', 'ws', command, localVmPath(vmx)]
  if (command === 'start') argv.push('nogui')
  return argv
}

export async function resolveVmwarePath(operationId: string): Promise<string> {
  try {
    const app = await resolveApplication({ appId: 'vmware-workstation', operationId })
    if (app.adapter !== 'vmware') throw new Error('VMware executable identity')
    return app.path
  } catch {
    throw new VmCommandError('vmware-not-installed', '注册表中未找到可用的 VMware Workstation 安装')
  }
}

type FilePort = { realpath(path: string): Promise<string>; stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }> }
const files: FilePort = { realpath, stat }

/** Resolve user-facing names only through a configured, Workstation, or verified running entry. */
export class VmAdapter {
  constructor(
    private readonly options: VmAdapterOptions = {},
    private readonly fs: FilePort = files,
    private readonly workstationInventory = readVmwareInventory,
  ) {}

  timeout(command: VmCommandInput['command']): number {
    if (command === 'start') return this.options.vmStartTimeoutMs ?? 90_000
    if (command === 'stop') return this.options.vmStopTimeoutMs ?? 30_000
    return command === 'list' ? 10_000 : 30_000
  }

  private async canonical(path: string, directory = false): Promise<string> {
    const normalized = localVmPath(path, !directory)
    try {
      const resolved = localVmPath(await this.fs.realpath(normalized), !directory)
      const info = await this.fs.stat(resolved)
      if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('wrong path type')
      return resolved
    } catch (error) {
      if (error instanceof VmCommandError) throw error
      throw new VmCommandError(directory ? 'vm-root-invalid' : 'vmx-not-found', '配置的 VMX 文件或根目录不存在或不可访问')
    }
  }

  async resolveVm(selector: string, running: () => Promise<readonly string[]>): Promise<string> {
    const pathSelector = /[:\\/]|\.vmx$/i.test(selector)
    if (pathSelector) localVmPath(selector)
    const roots = await Promise.all((this.options.vmAllowedRoots ?? []).map(root => this.canonical(root, true)))
    if (roots.length === 0) throw new VmCommandError('vmx-root-denied', '请先由用户配置 vmAllowedRoots')
    const allowed = (path: string) => roots.some(root => insideVmRoot(path, root))
    const wantedPath = pathSelector ? await this.canonical(selector) : undefined
    if (wantedPath && !allowed(wantedPath)) throw new VmCommandError('vmx-root-denied', '规范化后的 VMX 位于允许根目录之外')
    const matches = new Map<string, string>()
    const find = async (entries: readonly VmInventoryEntry[]) => {
      for (const entry of entries) {
        if (!wantedPath && entry.name.toLowerCase() !== selector.toLowerCase()) continue
        let vmx: string
        try { vmx = await this.canonical(entry.vmx) } catch (error) {
          if (!wantedPath) throw error
          continue
        }
        if (wantedPath && pathKey(wantedPath) !== pathKey(vmx)) continue
        if (!allowed(vmx)) throw new VmCommandError('vmx-root-denied', '规范化后的 VMX 位于允许根目录之外')
        matches.set(pathKey(vmx), vmx)
      }
    }
    await find([...(this.options.vmInventory ?? []), ...await this.workstationInventory()])
    if (matches.size === 0) {
      const paths = await running()
      await find(paths.map(vmx => ({ vmx, name: win32.basename(vmx, win32.extname(vmx)) })))
    }
    if (matches.size !== 1) {
      throw new VmCommandError(matches.size ? 'vmx-ambiguous' : 'vmx-not-allowlisted',
        matches.size ? 'VM 名称不唯一，请提供登记的 VMX 路径' : 'VMX 未出现在可信清单或已核实的本子会话运行列表中')
    }
    return [...matches.values()][0]
  }

  request(input: VmCommandInput, vmwarePath: string, vmxPath?: string): VmwareCommandRequest {
    vmrunArguments(input.command, vmxPath)
    return { operationId: input.operationId, command: input.command, vmwarePath, timeoutMs: this.timeout(input.command),
      ...(vmxPath ? { vmxPath } : {}) }
  }
}

export function vmCommandFailure(code: string, message: string, vmx: string | null,
  elapsedMs: number): Omit<VmwareCommandResult, 'childSessionId'> {
  return { status: 'failed', state: 'unknown', code, message, vmx, elapsedMs, exitCode: null,
    evidence: { vmrunList: [], processCheck: [] }, argv: [], vmrunPid: null, stdout: '', stderr: '', fallbackAllowed: false }
}
