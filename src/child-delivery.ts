import type { DesktopAction, DesktopOperation } from './native-contract.ts'
import { childKey } from './child-key.ts'

export function childDelivery(action: DesktopAction): DesktopOperation['delivery'] {
  if (action.type === 'type') return 'background'
  if (action.type === 'click' && action.button === 'left' && (action.count === 1 || action.count === 2)) return 'background'
  if (action.type === 'key' && childKey(action.key, action.modifiers)) return 'background'
  if (action.type === 'scroll' && (action.direction === 'up' || action.direction === 'down')) return 'background'
  throw new Error('子会话试用支持左键单击或双击、文本输入、垂直滚动及后台按键白名单；其他组合未发送')
}
