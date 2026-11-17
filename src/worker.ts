import { boundedParse, requestSchema, PROTOCOL_VERSION } from './protocol.ts'

// This process deliberately has no capture or input driver. Native execution is phase 3.
if (!process.send) throw new Error('Diagnostic worker requires an owned IPC channel')
let sequence = 0
process.on('message', (value: unknown) => {
  try {
    const request = boundedParse(requestSchema, value)
    process.send?.({ version: PROTOCOL_VERSION, id: request.id,
      kind: 'diagnostic-only', pid: process.pid, nativeDesktop: false,
      inputEnabled: false, sequence: ++sequence }, () => {
      if (request.method === 'shutdown') process.disconnect()
    })
  } catch {
    // A malformed peer cannot leave this worker available for more commands.
    process.exitCode = 2
    process.disconnect()
  }
})
process.on('disconnect', () => { process.exitCode ??= 0 })
