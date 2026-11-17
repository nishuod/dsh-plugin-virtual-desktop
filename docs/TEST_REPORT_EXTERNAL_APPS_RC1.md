# External application readiness — rc.1

2026-11-15, Windows x64. Evidence JSON and console log. Probe: `node tests/external-application.live.mjs --allow-owned-apps` after building.

The probe used the actual installed executable paths, one newly owned child session per application. It refused any pre-existing association and reset each owned session before proceeding. It sent no input or VM commands. Exported evidence contains hashes and aggregate metadata, not screenshot pixels, window titles, document text or UIA target names. Final Windows child association was null; all three resets returned stopped.

| Application | Actual result | Evidence and limit |
| --- | --- | --- |
| Notepad 11.2609.11.0 | `needs_review`, paused | Direct package executable opened a responsive same-image window. Privacy clear, positive pixels, 22 native UIA targets, but SDK tree was truncated. Generic readiness correctly withheld auto-ready; no document was edited. |
| Calculator 11.2607.0.0 | `unknown`, verify_frame | Direct package executable reached capture, then the driver returned `DriverError.Tool`. No frame or successful action assertion. The exact driver cause remains unresolved; this is not proof of missing package activation. |
| VMware Workstation 17.0.0 | `ready` | Exact executable/window PID, child session, connection, epoch and frame matched. Positive pixels, nontruncated UIA, clear privacy, 38 suggested UIA targets. No inventory/list/restore action was performed in this probe. |

One of three applications satisfied readiness. This is not an action-evaluation pass rate. The external application scenarios in the 20-task catalog remain skipped until their action-specific assertions and disposable data prerequisites are implemented.

The Notepad run also exposed a receipt issue: the launched process handed off to another process of the exact same executable, and the `needs_review` result reported the original launcher PID beside the verified window PID. The result now reports the bound window PID, consistent with ready results; a regression test verifies launcher PID 32 versus window PID 99. Native selection and authorization checks were unchanged. The retained before-fix probe records the original values rather than rewriting evidence.

These failures remain release gates. The generic adapter's nontruncated-evidence requirement and the execution identity checks have not been relaxed to make these applications pass. The owned WinForms fixture's successful generic readiness and named click remain separate evidence.
