import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'

export type ChildStartPermission = 'ask' | 'session-grant' | 'blocked'

export function sessionApprovalPolicy(ctx: Context, agent: ToolExecution['agent']): ApprovalPolicy {
  const approval = ctx.get('approval')
  return (agent && approval?.overrideOf?.(agent.session)) ?? approval?.config?.policy ?? 'ask'
}

/** Read the live Host policies for this call's session. Auto is a different grant. */
export function resolveChildStartPermission(ctx: Context, agent: ToolExecution['agent']): ChildStartPermission {
  if (sessionApprovalPolicy(ctx, agent) !== 'never') return 'ask'
  if (!agent) return 'blocked'
  const session = agent.session
  const preset = ctx.get('permissionPresets')?.current(session)
  const sandbox = ctx.get('sandboxPolicy')?.resolve({ session })
  return preset === 'danger-full-access' && sandbox?.mode === 'danger-full-access'
    ? 'session-grant'
    : 'blocked'
}
