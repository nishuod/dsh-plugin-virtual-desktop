# Reproducible live evaluation catalog

`scenarios.json` defines 20 cases across basic input, application adapters and failure paths. `npm run eval` validates the catalog path and produces `artifacts/evals/latest.json`. Without an opt-in driver all cases are **skipped**, `passRate` is null and coverage is zero. A catalog is not live evidence.

Use a disposable Windows x64 environment and the repository-owned `tests/fixtures/DesktopFixture.cs`. Build/open the fixture in a child session, verify title `DSH Desktop Test Fixture`, PID, childSessionId and connectionId, and reset it to the specified initial state before each case. Never use an existing user's application data or main desktop. The VMware list case needs a disposable test VM only if testing a nonempty list; no power operations are required. Stop and clean the owned fixture on every exit.

Provide a local fixture-driver module:

```powershell
npm run eval -- --driver C:/qa/fixture-driver.mjs --require-live
```

## Bundled owned-fixture driver

This checkout includes a driver for all 20 catalog cases. The driver compiles the current fixture source into a separate artifacts directory with the Windows .NET Framework C# compiler and verifies its hash, PID, child-session ID and connection ID. It refuses an existing child association and cleans up its own session after each case. Three VMware cases and the visual reference require their own setup. Missing prerequisites produce an explicit skip.

```powershell
npm run build
node scripts/build-eval-driver.mjs
npm run eval -- --driver artifacts/eval-live/driver.mjs --allow-owned-fixture --allow-owned-vmware --require-live
```

`--allow-owned-fixture` authorizes the copied application and owned child session. `--allow-owned-vmware` also opts into VMware read-only `vmrun list`, minimize/restore and opening a file picker without selecting any file. Run the visual capture-only probe, review the resulting VMware Home image and build with `node scripts/build-eval-driver.mjs --visual-reference <reviewed.jpg>`. The default is `evidence/b4/vmware-home.jpg`. The click requires the exact card bounds and a pixel comparison to the reviewed crop. The tool cases use real Cordis tool definitions with local, single-call approval and attachment test services. Basic fixture routes call `ApplicationLifecycle` and `NativeSession` directly. Neither route calls a model or checks a provider's chat UI. See the [rc.2 evaluation report](../docs/TEST_REPORT_EVAL_RC2.md) for results.

The association preflight distinguishes a successful `UINT_MAX` result, an observed `ERROR_NOT_FOUND` + `UINT_MAX` result (the native broker's no-child contract), a real child ID, and all other failures. It never interprets an arbitrary query error as proof that no child exists.

The module exports `async runScenario(scenario)` and `async cleanup()`. `runScenario` must actually open the owned target, capture before, perform the listed operation through the public authorized tool interface, capture after and check the case-specific assertion. It returns:

```js
{
  live: true,
  target: { pid, childSessionId, connectionId },
  receipt: { outcome, reason },
  before: { uia: 'redacted UIA state', screenshotSha256: '64 hex characters' },
  after: { uia: 'redacted UIA state', screenshotSha256: '64 hex characters' },
  assertionPassed: true,
  inputDelivered: false // mandatory for expected-denial cases
}
```

The runner checks success outcome, before/after UIA evidence and screenshot hashes, and the scenario's assertion. Action cases require changes in both observations. Cases marked `verification:"observation"` check a read-only command, image delivery, or restoration of the pre-minimize observation. These cases still require real observations and their own command, image or recovery proof. Denial cases require the specified reason and withheld input. The driver preserves the stage and latest receipt of a failed assertion.

Reports may contain UIA evidence returned by the driver. Redact it before returning, keep outputs local and review them before sharing. CI runs catalog mode; it does not grant desktop input permissions. `--require-live` makes missing coverage a failing exit code for a release acceptance run.
