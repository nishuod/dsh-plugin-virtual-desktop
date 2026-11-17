# RC evaluation evidence

Report updated 2026-11-15. Candidate `1.0.0-rc.1` remains unpublished. Evidence files retain the execution host's actual recorded UTC timestamps.

## Reproduction and fixes

The first current-source live run executed ten cases: 6 passed, 4 failed, 10 skipped. Clear, Enter (two cases) and selection replacement failed independent fixture-state assertions. See before keyboard fix.

The first keyboard fix completed standard EDIT character messages and Ctrl+A selection. Clear then passed, but Enter lacked a visible UIA change and replacement appended text after the SDK reclick cleared the selection: 7 passed, 3 failed, 10 skipped. See intermediate evidence.

The final input route preserves an already focused standard EDIT selection using fixed `EM_REPLACESEL`. It rechecks PID, session, root, focus, bounds and class before dispatch; unknown delivery never replays through the SDK. The fixture exposes key counters in a visible label so Enter is independently checked by both actual text newline/counter state and changed UIA/screenshot. Assertions were not removed. The ten-case run passed all ten executed cases, with ten explicit skips (50% catalog coverage).

The extended driver now implements fifteen cases. `basic-04-key` exercises Escape, distinct from `basic-05-enter`; the previous duplicate Enter case is not used to inflate distinct key coverage. Added cases exercise scroll offset/visible row movement, double-click count, stale frames after independently requested minimize/resize, and a real owned broker orphan. Minimize/resize are fixed self-mutations of the test executable, addressed by exact PID and a fresh acknowledged token. Orphan creation kills only the retained child-process handle; the existing native recovery path must remove its own association.

## Current run

Final run recorded at **2026-11-15T03:36:25.617Z**: **15 executed, 15 passed, 0 failed, 5 skipped**, executed-case pass rate 100%, catalog coverage 75%. `runStatus=incomplete`, `runErrors=[]`. Live JSON, console log. The command used `--require-live` and correctly exited **1** because five scenarios remain skipped; this is not a complete release-gate pass.

The final run includes tightened failure evidence: minimized/resized/revoked/reused scenarios must match their exact expected refusal and preserve the same live connection/child session. Unrelated JS or transport errors fail the test. Reporter regression tests prove that cleanup failure writes a current failed report instead of leaving an old successful file. All fifteen supported cases passed after these changes, with cleanup complete.

Five scenarios remain outside the bundled driver: Notepad document editing, Calculator named digit, VMware inventory/list, VMware restore/menu, and deterministic replacement of a captured HWND by another PID. Real exit/restart is not relabeled `identity-changed`; unavailable external app fixtures are not counted as passing. A separate external application readiness probe does not establish these action assertions.

## Scope and rerun

```powershell
npm run build
node scripts/build-eval-driver.mjs
npm run eval -- --driver artifacts/eval-live/driver.mjs --allow-owned-fixture
```

Use `--require-live` for the complete release gate: it fails if any case is skipped. Never run live drivers concurrently. The driver refuses an existing Windows child association, recompiles and hashes its dedicated fixture, verifies target identity, and resets its owned session after every case. Success requires a specific independent fixture-state assertion, changed nonempty UIA and changed screenshot SHA256. Expected failures require the exact reason and evidence that input was withheld.

These probes exercise the real `ApplicationLifecycle` / `NativeSession` route with explicit trusted fixture authorization. They do not test the separate Harness chat approval UI or attachment admission. The [40-action benchmark](TEST_REPORT_DESKTOP_BENCHMARK_RC1.md) is a separate latency measurement, not twenty distinct evaluated tasks. Full v1.0 evaluation acceptance remains open.
