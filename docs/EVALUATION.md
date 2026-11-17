# Evaluation and benchmarks

Evaluation tools run from a source checkout. The npm runtime package excludes executable test sources and fixture binaries. No evaluation command should target an existing user's desktop or application data.

`npm run eval` validates the 20-case catalog and writes `artifacts/evals/latest.json`. Without a driver it reports skipped cases, zero coverage and no pass rate. The bundled driver covers the Windows fixture, three explicitly opted-in VMware cases and controlled Cordis attachment failure. Read the [rc.2 evaluation report](TEST_REPORT_EVAL_RC2.md) for results and the source checkout's `evals/README.md` for setup.

After building the plugin, build the dedicated fixture-driver output and explicitly opt into a live run:

```powershell
node scripts/build-eval-driver.mjs
npm run eval -- --driver artifacts/eval-live/driver.mjs --allow-owned-fixture --allow-owned-vmware --require-live
```

The live driver must establish that there is no existing Windows child association before opening its own session. It verifies the fixture binary and process/window identity, records real UIA and image hashes, checks independent fixture state, then cleans up only its own session. The VMware click requires a reviewed 1280×808 VMware Home JPEG for the visual reference. The VMware list is read-only. The Open dialog case leaves the file selection empty. `--require-live` returns a failure exit code for skips or failed cases. Inspect the latest report's `executed`, `passed`, `failed`, `skipped`, `coverage` and per-case reasons.

`runStatus` is `passed`, `incomplete` (skips remain), or `failed`. `runErrors` records execution/cleanup failures independently of scenario counts. Cleanup failure still writes the current report and returns a nonzero exit code; an old successful file is not reused. Failure scenarios require their specific guard, not merely an arbitrary thrown error. The separate [external readiness probe](TEST_REPORT_EXTERNAL_APPS_RC1.md) does not count as an action scenario.

The [desktop benchmark report](TEST_REPORT_DESKTOP_BENCHMARK_RC1.md) is a separate 40-step local measurement: 20 named clicks per image-size profile, each with counter/UIA/screenshot verification. It excludes model and chat approval latency and is not a 20-scenario evaluation pass rate. `npm run bench` is a reproducible synthetic encoding microbenchmark, also separate from desktop latency.
