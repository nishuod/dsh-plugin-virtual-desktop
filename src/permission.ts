import { DesktopError } from './protocol.ts'

/** Phase 2 exposes diagnostics only. No model or Client boolean grants native access. */
export class PermissionGate {
  readonly nativeDesktop = false
  assertNativeAccess(): never {
    throw new DesktopError('permission-denied', 'Phase 2 has no authorized native desktop backend')
  }
}
