/** Exact child-session key capability; never infer extra shortcuts from modifiers. */
export function childKey(key: string, modifiers: readonly string[]): { virtualKey: number; extended: boolean; control: boolean } | undefined {
  const normalized = key.toLowerCase()
  if (modifiers.length === 1 && modifiers[0] === 'ctrl' && /^[a-z]$/.test(normalized)) {
    return { virtualKey: normalized.toUpperCase().charCodeAt(0), extended: false, control: true }
  }
  if (modifiers.length !== 0) return
  const keys: Record<string, number> = {
    enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, backspace: 0x08,
    left: 0x25, up: 0x26, right: 0x27, down: 0x28, space: 0x20,
    home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, f5: 0x74,
  }
  const virtualKey = keys[normalized]
  return virtualKey === undefined ? undefined : { virtualKey, extended: virtualKey >= 0x21 && virtualKey <= 0x28, control: false }
}
