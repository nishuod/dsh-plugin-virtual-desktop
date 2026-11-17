# Security policy and threat model

Applies to `1.0.0-rc.2`. This release candidate is a Windows desktop execution layer with explicit authorization and evidence. It is not a VM, an application sandbox, an antivirus product or a guarantee that a model will choose a safe action.

## Trust boundaries

| Boundary | Required checks and limits |
| --- | --- |
| Model/tool request → host | Strict schemas and bounded inputs; a model-supplied boolean cannot grant permission. Only the owner can invoke panel Remote controls. |
| Host → child executor | Private owned transport, connection identity, random authentication material, expected parent/child Windows session and pipe peer identity. No network listener or fallback to the main desktop. |
| Executor → target window | Discovered opaque window ID, PID/process birth, session identity, authorized epoch, current geometry/focus and valid frame. A process name alone is insufficient. |
| Screenshot → action | Frame ID, epoch, source, age and single-use consumption. Refresh, rebind, pause, stop, disconnect or revocation invalidates old authority. |
| Recovery → Windows session | Only retained ownership records and the exact owned broker identity can authorize cleanup. Reset does not enumerate and kill processes by name, reset a foreign association or grant new input authority. |
| Application command → executable | Fixed app-command allowlists and argument construction. No user-supplied shell command, arbitrary executable command path or arbitrary argv passthrough. |

PiP uses the current Windows account in a distinct child session. Files, application settings, network access and account privileges remain shared. A malicious local process running as the same user, an administrator, a compromised operating system, a compromised dependency or an application that lies about UIA is outside this boundary. The model and application content are untrusted when selecting actions.

## Authorization and revocation

Initial observation and input are disabled. PiP launch/binding and direct actions follow the Harness permission policy: a verified Full Access session with never-ask may use its active session grant; other permitted flows request an allowed-once approval. Restricted never-ask does not silently acquire Full Access. Side effects recheck current authority after approval and before dispatch.

Input binds `connectionId`, epoch, parent/child session and the selected target's PID/window identity. PiP uses its restricted background routes; it cannot promote an action to the attended main desktop. Attended debugging has its own explicit owner authorization. `desktop_reset_child_session` refuses to terminate an active attended connection.

Operation IDs prevent accidental replay during the retained receipt lifetime. Changed parameters cannot reuse the same ID. A delivered message is not proof that the application achieved the intended state. `unknown` can mean a partial or already-completed side effect; it is never automatically retried. Stop closes admission, revokes authority and drains work; an operating-system action already dispatched cannot be undone by revocation.

`desktop_start_task` is experimental and disabled by default. Enabling it does not remove per-step owner review or independent result verification.

## Rejected capabilities and inputs

The plugin refuses unsupported platforms, unknown/extra schema fields, invalid or stale frame/connection identifiers, unverified target identities, cross-session targets, revoked grants and unsupported action combinations. Selected shells, credential UI, plugin/host windows and system shell surfaces are excluded. This filtering is limited: an ordinary application can still perform consequential operations.

Application launch accepts a validated local absolute `.exe` path and no caller-supplied arguments. UNC/device paths, path traversal and command-line concatenation are rejected by the launch/command validators. A program's elevation prompt or cross-session single-instance behavior does not grant permission to follow it.

The privacy helper is a fixed internal read-only Windows PowerShell script with decimal HWND/PID input, a fixed executable location, bounded output and timeout. It is not exposed as a command-execution tool. Image encoding remains in the worker. See [PRIVACY.md](docs/PRIVACY.md) for masking and data flow.

## VMware app commands

The only current application-command adapter uses VMware Workstation's verified installation and fixed `vmrun` vectors for `list`, `start`, `stop`, `suspend` and `reset`. Credential flags, arbitrary flags and arbitrary command names are not accepted. `start` uses a fixed `nogui` argument.

Read-only list requires a verified VMware child-session binding. Power commands require the effective Full Access policy and, where policy asks, one-time approval. VM selection is tied to known inventory or verified running entries, canonical local VMX paths and configured allowlisted roots. Ambiguous names, unregistered copies, traversal, UNC/device paths and foreign-session processes are refused or reported as unknown. Pipe/session/window/PID/epoch scope is checked again before dispatch.

The internal adapter registry describes readiness evidence and existing allowed capabilities. It cannot extend the native action/command whitelist. A public third-party adapter SDK is outside the v1.0 promise.

## Recovery and privacy limitations

The watchdog revokes a lost connection and attempts owned teardown. Active, orphan and unproven associations have distinct guidance. A legacy orphan without retained proof of ownership cannot be force-cleared safely by this plugin. Cleanup failure is reported and may leave local ownership records for a later reset; no claim of unconditional recovery is made.

Password detection relies on accurate application UIA information. Agreement between UIA and HWND physical coordinates is insufficient to verify bitmap pixel alignment; live review found displaced selective masks. Production therefore blocks the entire frame and rejects input whenever a password region or configured exclusion rectangle exists, a title blacklist matches, or the privacy scan is incomplete. Password/exclusion cases report `sensitive-geometry-unverified`. There is no public tool/configuration bypass to selective masking. This intentionally makes sensitive windows unavailable rather than claiming their local geometry has been solved.

Window discovery metadata and ordinary text remain observable after the owner grants access. Applications that do not expose password semantics can still reveal sensitive content. Screenshots or UIA can be sent to the configured model through Harness, and stop cannot retract content already sent. See [PRIVACY.md](docs/PRIVACY.md).

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/nishuod/dsh-plugin-virtual-desktop/security/advisories/new). Include the plugin version and build hash, the Windows version, a minimal reproduction and the authorization boundary involved. Review any attachments and remove credentials, personal data and private screen contents before sharing.
