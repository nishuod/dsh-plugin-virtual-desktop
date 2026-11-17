import { win32 } from 'node:path'
import { z } from 'zod'
import { childExecutableSchema } from './child-launch.ts'
import { appBrokerTransportErrorSchema, callAppBroker } from './app-broker-client.ts'

export const vmwareCommandNameSchema = z.enum(['list', 'start', 'stop', 'suspend', 'reset'])
export type VmwareCommandName = z.infer<typeof vmwareCommandNameSchema>
export const vmxPathSchema = z.string().min(7).max(1024).refine(path =>
  /^[a-z]:[\\/]/i.test(path) && !/[\x00-\x1f"<>|?*]/.test(path) &&
  !path.slice(2).includes(':') && win32.extname(path).toLowerCase() === '.vmx' &&
  path.slice(3).split(/[\\/]/).every(part => part.length > 0 && !/[. ]$/.test(part)),
  '须提供已解析的本地绝对 .vmx 路径',
)
const vmwarePathSchema = childExecutableSchema.refine(path => win32.basename(path).toLowerCase() === 'vmware.exe')
const pidSchema = z.int().positive().lt(0xffffffff)
const commandFields = z.strictObject({
  operationId: z.uuid(),
  vmwarePath: vmwarePathSchema,
  command: vmwareCommandNameSchema,
  vmxPath: vmxPathSchema.optional(),
  timeoutMs: z.int().positive().max(180000),
})

const commandTimeouts = {
  list: [10000, 10000],
  start: [30000, 180000],
  stop: [15000, 60000],
  suspend: [10000, 30000],
  reset: [10000, 30000],
} as const

function validCommand(input: z.infer<typeof commandFields>): boolean {
  const [minimum, maximum] = commandTimeouts[input.command]
  return (input.command === 'list') === (input.vmxPath === undefined) &&
    input.timeoutMs >= minimum && input.timeoutMs <= maximum
}

export const vmwareCommandRequestSchema = commandFields.refine(validCommand, 'VM 命令的路径或超时不符合白名单')
export type VmwareCommandRequest = z.infer<typeof vmwareCommandRequestSchema>

export const vmwareCommandScopeSchema = z.strictObject({
  expectedEpoch: z.int().nonnegative(),
  windowId: z.uuid(),
  pid: pidSchema,
  vmwarePath: vmwarePathSchema,
  invalidateFrame: z.boolean(),
})
export type VmwareCommandScope = z.infer<typeof vmwareCommandScopeSchema>

export const vmwareCommandTransportSchema = commandFields.extend({
  expectedEpoch: z.int().nonnegative(),
  windowId: z.uuid(),
  pid: pidSchema,
}).refine(validCommand, 'VM 命令的路径或超时不符合白名单')

export const vmwareProcessIdentitySchema = z.strictObject({
  vmwareHwnd: z.string().regex(/^[1-9]\d{0,19}$/),
  vmwareBirth: z.string().regex(/^[0-9a-f]{16}$/),
})
export type VmwareProcessIdentity = z.infer<typeof vmwareProcessIdentitySchema>

export const vmwareCommandResultSchema = z.strictObject({
  status: z.enum(['confirmed', 'failed', 'unknown']),
  state: z.enum(['listed', 'running', 'stopped', 'suspended', 'unknown']),
  runningCount: z.int().nonnegative().max(32).optional(),
  message: z.string().max(1000),
  vmx: vmxPathSchema.nullable(),
  vmPid: pidSchema.nullable().optional(),
  exitCode: z.int().nullable(),
  childSessionId: pidSchema,
  evidence: z.strictObject({
    vmrunList: z.array(vmxPathSchema).max(32),
    processCheck: z.array(z.strictObject({
      pid: pidSchema,
      vmxPath: vmxPathSchema,
      cpuMs: z.number().finite().nonnegative().nullable(),
    })).max(32),
  }),
  elapsedMs: z.number().finite().nonnegative(),
  argv: z.array(z.string().max(1024)).max(5),
  vmrunPid: pidSchema.nullable(),
  stdout: z.string().max(4096),
  stderr: z.string().max(4096),
  code: z.string().max(100).nullable().optional(),
  transportError: appBrokerTransportErrorSchema.optional(),
  fallbackAllowed: z.boolean(),
}).refine(result => !result.fallbackAllowed || result.status === 'failed')
  .refine(result => !result.transportError || (result.status === 'unknown' && result.code === 'app-broker-disconnected'))
  .refine(result => result.state === 'listed'
    ? result.status === 'confirmed' && result.vmx === null && result.vmPid == null &&
      result.runningCount === result.evidence.vmrunList.length && result.runningCount === result.evidence.processCheck.length
    : result.runningCount === undefined)
export type VmwareCommandResult = z.infer<typeof vmwareCommandResultSchema>

export function sameWindowsPath(left: string | undefined, right: string): boolean {
  return left !== undefined && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
}

export function matchesVmwareCommandTarget(result: VmwareCommandResult, vmxPath: string | undefined): boolean {
  if (vmxPath === undefined) return result.vmx === null &&
    result.state === (result.status === 'confirmed' ? 'listed' : 'unknown')
  if (result.state === 'listed') return false
  // A native refusal can occur before the target path has been opened and verified.
  if (result.vmx === null) return result.status === 'failed'
  return sameWindowsPath(result.vmx, vmxPath)
}

type BrokerCommand = VmwareCommandRequest & VmwareProcessIdentity & { vmwarePid: number }
export type VmwareCommandRunner = (input: BrokerCommand, signal: AbortSignal, beforeSend: () => void,
  verifyPid: (pid: number) => void) => Promise<VmwareCommandResult>

export const runVmwareCommand: VmwareCommandRunner = async (input, signal, beforeSend, verifyPid) => {
  const { vmwarePath, vmwarePid, vmwareHwnd, vmwareBirth, command, vmxPath, timeoutMs } = input
  const result = await callAppBroker({
    kind: 'vmware-command', vmwarePath, vmwarePid, vmwareHwnd, vmwareBirth, command, vmxPath, timeoutMs,
  }, { timeoutMs: timeoutMs + 10000, maxReplyBytes: 262144, signal, beforeSend, verifyPid })
  return vmwareCommandResultSchema.parse(result)
}
