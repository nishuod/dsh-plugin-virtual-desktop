import type { DesktopFrame, DesktopWindow } from './native-contract.ts'

/** Trusted in-process adapters describe evidence only. They cannot run commands. */
export interface ApplicationAdapter {
  readonly id: string
  readonly actions: readonly string[]
  readonly commands: readonly string[]
  matchesExecutable(path: string): boolean
  mainWindow(window: DesktopWindow): boolean
  readyEvidence(frame: DesktopFrame): boolean
}
const actions = Object.freeze(['click', 'type', 'key', 'scroll'])
export class ApplicationAdapterRegistry {
  private readonly entries = new Map<string, ApplicationAdapter>()
  register(adapter: ApplicationAdapter): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(adapter.id) || this.entries.has(adapter.id)) throw new Error('Invalid or duplicate adapter ID')
    // This registry never broadens the executor whitelist, even for trusted extensions.
    if (adapter.actions.some(action => !actions.includes(action)) ||
      adapter.commands.some(command => adapter.id !== 'vmware' || !['list','start','stop','suspend','reset'].includes(command)))
      throw new Error('Adapter capability exceeds the executor whitelist')
    this.entries.set(adapter.id, Object.freeze({...adapter, actions:Object.freeze([...adapter.actions]), commands:Object.freeze([...adapter.commands])}))
  }
  get(id: string): ApplicationAdapter {
    const adapter = this.entries.get(id)
    if (!adapter) throw new Error('Unknown application adapter')
    return adapter
  }
  resolve(path: string): ApplicationAdapter {
    return [...this.entries.values()].find(adapter => adapter.id !== 'generic' && adapter.matchesExecutable(path)) ?? this.get('generic')
  }
}
export const applicationAdapters = new ApplicationAdapterRegistry()
applicationAdapters.register({
  id:'vmware', actions, commands:['list','start','stop','suspend','reset'],
  matchesExecutable:path => /(?:^|[\\/])vmware\.exe$/i.test(path),
  mainWindow:window => /^VMUIFrame$/i.test(window.windowClass ?? '') && /VMware Workstation/i.test(window.title),
  readyEvidence:frame => /\bFile\b|文件/.test(frame.tree) && /\bVM\b|虚拟机/.test(frame.tree) && /\bHelp\b|帮助/.test(frame.tree),
})
applicationAdapters.register({
  id:'generic', actions, commands:[], matchesExecutable:() => true,
  mainWindow:window => Boolean(window.responsive && window.windowClass && window.windowClass !== '#32770' && window.title.trim()),
  // A stable top-level window plus positive, nontruncated UIA and pixels is required.
  readyEvidence:frame => !!frame.accessibility && !frame.accessibility.treeTruncated &&
    (frame.accessibility.status==='available'||frame.accessibility.status==='limited'&&frame.privacy?.status==='clear'&&
      frame.accessibility.suggestedTargets?.some(target=>target.name.trim()&&/^(Button|Edit|MenuItem|ComboBox)$/i.test(target.controlType))===true) &&
    /\b(button|edit|menuitem|menu item|document|textbox)\b|按钮|编辑|菜单项|文档/i.test(frame.tree),
})
