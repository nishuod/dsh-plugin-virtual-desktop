# RC.1 real local desktop latency benchmark

Run started 2026-11-13T06:33:21Z (14:33:21 Asia/Shanghai), Windows 11 Pro x64, build 26200, candidate `1.0.0-rc.1`. The [opt-in probe](../tests/desktop-benchmark.live.mjs) used a dedicated copy of the repository's WinForms fixture, in newly created Windows child sessions. It refused to run if a child association already existed. No model provider was called and no user document was edited.

## Measurements

Each profile opened a fresh fixture, verified generic application `ready`, then performed 20 consecutive named `增加计数` / `Button` clicks. Each action used the preceding frame once, rescanned native UIA before dispatch, and acquired a new privacy-checked screenshot/UIA observation afterward. The independent fixture-state file was checked against the launched PID and required exactly one counter increment per action. All 40 actions also changed the UIA text and screenshot SHA256. Both sessions stopped cleanly; final Windows child association was null.

| Screenshot max dimension | Actual JPEG size | Verified steps | Mean full step | Observed step range | Mean JPEG bytes | Illustrative image tokens |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| 1280 (baseline) | 882 × 670 | 20/20 | 2233.90 ms | 2093.98–2397.76 ms | 36876.60 | 765 |
| 640 (economy) | 640 × 486 | 20/20 | 2164.39 ms | 2094.43–2405.15 ms | 22097.55 | 425 |

The smaller-image profile reduced JPEG bytes by **40.08%** and measured mean local step time by **3.11%** in this run. The overlapping latency ranges and single sequential run do not establish a general performance improvement. UIA/privacy helper work dominates much of this small fixture's step time; reducing pixels primarily reduces transport volume.

The timing starts immediately before `NativeSession.execute` and ends when its receipt returns with the after-frame. It includes target UIA revalidation, native input dispatch, privacy scans, screenshot encoding and local frame persistence. It excludes initial application opening, user/Harness approval UI, model inference, networking and post-receipt independent fixture-file assertions. These are real local executor timings, not full conversational task latency.

The token column is only the same illustrative heuristic used by `scripts/bench.mjs`: `85 + 170 × ceil(width/512) × ceil(height/512)`. It is not a provider's tokenizer, actual billed usage, price or benchmark score. Text-only UIA observations and unchanged-image suppression were not benchmarked here.

## Evidence and reproduction

- Complete measured samples: 20 per profile, exact byte counts, dimensions, timing, privacy status, UIA/hash changes and final association.
- Console log.
- [Orphan reset and one-call generic reopen/name-click evidence](TEST_REPORT_SESSION_RECOVERY_RC1.md).
- `npm run bench` separately measures synthetic encoding only; its figures must not be substituted for these full local steps.

Bundle `tests/desktop-benchmark.live.mjs` with esbuild (`bundle`, `packages:external`, Node ESM), beside matching current-source `child-session-bridge.js`, `native-worker.js` and built `child-session-host/`. Copy `tests/fixtures/dsh-desktop-fixture.exe` to a dedicated writable test directory. Run the bundled probe with `--run-owned-test`, the fixture's absolute path, and a JSON output path. The test accepts only that fixture filename, refuses any pre-existing Windows child association, and resets only its own sessions in the finalizer.

This is a repeated-action latency test, not the 20-scenario application/failure evaluation suite. It does not assert Notepad/Calculator or VMware coverage, and it does not publish any npm package.
