# dsh-plugin-virtual-desktop

English · [简体中文](README.zh-CN.md)

An auditable, model-independent Windows desktop execution layer for **DeepSeek Harness**. It opens a verified application in a Windows picture-in-picture (PiP) child session, shows the window through screenshots and UI Automation (UIA), and returns evidence and failure reasons for each authorized action.

[GitHub Release v1.0.0-rc.2](https://github.com/nishuod/dsh-plugin-virtual-desktop/releases/tag/v1.0.0-rc.2) is a prerelease. Install it from the `.tgz` release asset. The package and its `rc` tag are pending publication to npm. [Release verification](docs/TEST_REPORT_RC2_RELEASE.md)

## Install and verify

Use Windows 11 Pro x64 with Windows Child Sessions enabled, DeepSeek Harness `0.2.2-rc.1`, Node.js `>=24.9`, and the .NET 8 Desktop Runtime x64. Windows 10 x64 remains a target with live acceptance pending. See the [platform matrix](docs/SUPPORTED-PLATFORMS.md) and [installation guide](docs/INSTALL.md).

1. Download `dsh-plugin-virtual-desktop-1.0.0-rc.2.tgz` and `SHA256SUMS` from the [release page](https://github.com/nishuod/dsh-plugin-virtual-desktop/releases/tag/v1.0.0-rc.2) into the same folder. Exit Harness and run PowerShell in that folder. Use the CLI shipped with Harness if `dsh` is absent from your PATH.

   ```powershell
   $name = 'dsh-plugin-virtual-desktop-1.0.0-rc.2.tgz'
   $archive = (Resolve-Path -LiteralPath $name -ErrorAction Stop).Path
   $entry = Get-Content -LiteralPath 'SHA256SUMS' -ErrorAction Stop |
     Where-Object { $_ -match ('^[0-9a-f]{64}\s+' + [regex]::Escape($name) + '$') }
   $expected = $entry -split '\s+' | Select-Object -First 1
   if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256 -ErrorAction Stop).Hash -ne $expected) {
     throw 'Release checksum does not match SHA256SUMS.'
   }
   dsh plugin --profile desktop add $archive --ignore-scripts
   ```

2. Reopen Harness. In **Plugins**, enable `dsh-plugin-virtual-desktop`. Open **虚拟桌面工具** (Virtual desktop tools), select the Windows child-session backend, and approve PiP startup when prompted.

3. Call `desktop_get_diagnostics` and check `plugin.version`, `plugin.buildHash`, and `plugin.builtAt`. Then call `desktop_open_application` with `{"appId":"vmware-workstation"}` if VMware Workstation is installed, or pass the absolute `path` to an allowed application. After the window is ready and authorized, call `desktop_get_screenshot` for a fresh frame. See the [quickstart](docs/QUICKSTART.md) for one authorized click and its evidence.

Keep the tarball at the installed path while your profile uses it. Replace `desktop` in the CLI command if you use another profile. For rollback, quit Harness, verify your retained rc.1 tarball against its trusted checksum, and run the following from the folder containing it.

```powershell
$rollback = (Resolve-Path -LiteralPath 'dsh-plugin-virtual-desktop-1.0.0-rc.1.tgz' -ErrorAction Stop).Path
dsh plugin --profile desktop add $rollback --ignore-scripts
dsh plugin --profile desktop list dsh-plugin-virtual-desktop --depth 0
```

The list should show `dsh-plugin-virtual-desktop@1.0.0-rc.1`. Reopen Harness and authorize the window again.

## Capabilities

- **Observe and act.** Capture a window frame with UIA metadata, select a named control or a visual candidate, and inspect the resulting action receipt. Each frame authorizes at most one input. Use image mode for custom-drawn controls. UIA-only mode omits pixels and visual candidates.
- **Manage applications and sessions.** Open and restore verified windows, rebind after geometry changes, and recover from an orphan child session confirmed to belong to this plugin. VMware Workstation 17 has a dedicated adapter. Generic executables may require manual review. [Application support](docs/SUPPORTED-APPS.md)
- **Diagnose problems.** Inspect connection and build identity, turn failures into structured reasons, and export a local diagnostic ZIP. [Public API](docs/PUBLIC-API.md)

Harness controls which model receives screenshot pixels or UIA text. This data can leave the machine depending on the configured provider. A detected password field, privacy exclusion, or incomplete scan blocks the frame and input. Windows file permissions still govern the child session. Files saved to shared local paths can remain visible in the main session after PiP closes. [Privacy](docs/PRIVACY.md) · [Security](docs/SECURITY.md)

`desktop_start_task` is experimental and disabled by default. Application commands use a fixed executable and argument allowlist. The public API includes [tool schemas](docs/PUBLIC-API.schema.json) and [response schemas](docs/PUBLIC-API.responses.schema.json).

## Build and contribute

Build from source on Windows x64 with Node.js `>=24.9` and the .NET 8 SDK.

```powershell
npm ci --ignore-scripts
npm run build
npm test
npm run verify:package
npm run release:prepare
```

`npm test` runs automated tests without sending desktop input. The rc.2 validation recorded 20 of 20 Windows live scenarios passing. `npm run eval` defaults to catalog mode. [Evaluation guide](docs/EVALUATION.md) · [rc.2 live results](docs/TEST_REPORT_EVAL_RC2.md) · [Contributing](docs/CONTRIBUTING.md) · [Release workflow](docs/RELEASING.md)

Released under the [MIT license](LICENSE). See [third-party notices](docs/THIRD_PARTY_NOTICES.md) for bundled dependencies.
