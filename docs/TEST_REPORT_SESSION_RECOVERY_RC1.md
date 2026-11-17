# RC.1 child-session recovery validation

Report updated 2026-11-13 (Asia/Shanghai), baseline `0.5.0-preview.14`, candidate `1.0.0-rc.1`. No original safety assertion was relaxed. This checkout is a source snapshot without Git metadata.

## Reproduction and correction

The terminal-stop regression was reproduced before the change: when both transport stop and teardown failed, task `active` remained true. The preserved test failed `true !== false`; see before-terminal-stop.log. Stop now finalizes its task state in a finally path, independent of transport success.

Recovery retains the exact child clients created by this host until cleanup succeeds. A per-run native ownership record binds the recovery token, run directory, companion executable, parent/child sessions, child logon timestamp and original broker process birth. Normal close joins the broker, then verifies/clears any remaining owned association. Reset coalesces concurrent callers and retries retained cleanup without reopening input. A reset starting during enable's asynchronous lifecycle join cannot be bypassed by the joining enable.

The original safety model remains: connectionId/epoch/window/PID checks, parent-child separation, single-use frame consumption, immediate authorization revocation, no command interpreter, no main-desktop fallback, and no foreign session/process teardown. An unproven legacy association is refused rather than guessed.

## Automated and native checks

| Check | Evidence/result |
| --- | --- |
| Focused final session/task suite | 25 passed, 0 failed; rc1-recovery-final-tests.log |
| Concurrent/reset retry, stale identity, attended-mode refusal | Covered by `tests/session-recovery.test.ts` |
| 20 serialized mocked stop/reset cycles | Covered by `tests/session-recovery.test.ts`, separate from the real cycles below |
| Heartbeat loss | Pending request rejected, notice emitted once, teardown once; deterministic transport test |
| Reset/enable admission race | New regression keeps enable blocked until owned orphan cleanup joins |
| Native helper build | .NET build passed with 0 warnings/errors; native build log |
| Native negative ownership cases | Wrong token rejected; missing record is a no-op; foreign parent rejected without mutation; JSON |

The focused command was `node --import tsx --test tests/session-recovery.test.ts tests/child-session-cleanup.test.ts tests/child-session-bridge.test.ts tests/lifecycle-serialization.test.ts tests/tasks.test.ts`.

## Real Windows orphan and 20-cycle test

The opt-in [live probe](../tests/session-recovery.live.mjs) first checks that Windows has no child association. It opens its own PiP, kills only its retained broker ChildProcess handle, observes that association 2 remains, then resets. Reset returns `stopped`, and the Windows association is absent. This is a real orphan, not a mocked transport failure.

It then completes 20 real open/stop cycles, child sessions 3 through 22. Every cycle verifies the newly opened association, stopped state, absent association after stop, and an empty owned-client set. There are no EPIPE errors or other recorded failures; final association is null. Cycle elapsed times range 13.092–17.755 seconds. The retained result is rc1-recovery-live.json, with console log. This evidence records 2026-11-12T11:14:13Z (19:14:13 Asia/Shanghai); the test was not repeated just to update the report date.

## Application reopen follow-up

A second real orphan/reset run on 2026-11-13 verified reset and opened a dedicated copy of the generic WinForms fixture. The new child, screenshot and privacy scan succeeded; native UIA returned the named `增加计数` button. The first application attempt paused at `needs_review` because SDK accessibility was `limited` and the generic readiness gate required `available`. The tree was not truncated and had no unnamed buttons; independent native targets were available. This application-readiness failure is preserved in rc1-recovery-application-live.json.

The generic adapter now also accepts a nontruncated limited SDK tree when an independent successful native privacy/UIA scan supplies a named interactive target and visual evidence is positive. It still rejects unavailable/empty, truncated or privacy-blocked evidence. The final run at 2026-11-13T06:31:55Z (14:31:55 Asia/Shanghai) used rebuilt current-source bundles, including the DPI-aware native scanner. It killed only its newly spawned broker PID 11140, observed association 2 retained, and reset to `stopped` with no association. Exactly one application-open call then returned `ready` in child session 3.

The named `增加计数` / `Button` click returned `delivered`. An independent fixture-state file, checked against the launched PID, confirmed counter 0 → 1. The receipt reported a unique UIA target, changed UIA text and changed screenshot hash. A further real open/stop cycle completed in 14.442 seconds; final association was null and errors were empty. See final JSON and console log.

This probe invokes the same `ApplicationLifecycle.open` and `NativeSession.execute` services used by the public tools, with an explicit test-owned authorization callback. It verifies real native behavior and state, but does not separately exercise the Harness chat approval UI or tool attachment-admission transport. The fixture executable and its state file were copied to a dedicated artifacts directory; pre-existing user application data was not used.

## Limits

The 20-cycle test covers this Windows environment; it is not a clean-machine installation test. A process restart loses the in-memory ownership capability, so this release does not claim recovery of arbitrary legacy orphans. Tests do not prove cleanup of a foreign association, and the implementation intentionally refuses it. A failed ownership or cleanup check leaves authorization revoked and reports failure rather than claiming a stopped foreign session.
