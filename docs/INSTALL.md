# Installation

Version `1.0.0-rc.2` targets DeepSeek Harness `0.2.2-rc.1`. Download the tarball and SHA256SUMS from the [GitHub prerelease](https://github.com/nishuod/dsh-plugin-virtual-desktop/releases/tag/v1.0.0-rc.2). The plugin is currently distributed as a tarball.

## Prerequisites

Use Windows x64, Node >=24.9 and .NET 8 Desktop Runtime x64, with Windows Child Sessions enabled under the machine's policy. Consult [SUPPORTED-PLATFORMS](SUPPORTED-PLATFORMS.md); Windows 10 clean-machine verification remains pending. Production dependencies include CUA Driver, Koffi and Sharp native binaries. Building the plugin also requires .NET 8 SDK; end users install the compiled package.

## Existing Harness profile

Obtain the candidate tarball and matching `SHA256SUMS`. Exit Harness using its application menu. Use the CLI shipped with your installation or use `dsh` from PATH. Replace the example path with your archive location.

```powershell
Get-FileHash 'C:\Downloads\dsh-plugin-virtual-desktop-1.0.0-rc.2.tgz' -Algorithm SHA256
dsh plugin --profile desktop add 'C:\Downloads\dsh-plugin-virtual-desktop-1.0.0-rc.2.tgz' --ignore-scripts
```

For an upgrade where the CLI requires removal first:

```powershell
dsh plugin --profile desktop remove dsh-plugin-virtual-desktop
dsh plugin --profile desktop add 'C:\Downloads\dsh-plugin-virtual-desktop-1.0.0-rc.2.tgz' --ignore-scripts
```

The [profile example](examples/desktop-profile/package.json) shows the semver dependency intended for use after registry publication.

Maintainers can verify a prepared local tarball with `npm run verify:install -- <candidate.tgz>` from a source checkout. It uses a fresh temporary npm dependency tree and tests the diagnostic channel without opening a desktop. A passing result is not evidence that the package is already published or that a clean Windows machine has all prerequisites.

Reopen Harness. Enable the bundle in Plugins. Use `desktop_open_child_session` and grant the startup permission; opening an application and approving input remain separately scoped. `desktop_get_diagnostics` reports connection state. A healthy diagnostic worker alone does not mean a desktop is connected. Use `desktop_open_application` to start and verify a target, then capture a fresh frame with an image-capable model. See [QUICKSTART](QUICKSTART.md).

## Configuration

| Setting | Default | Bounds |
| --- | --- | --- |
| workerTimeoutMs | 5000 | 100–30000 ms |
| nativeTimeoutMs | 15000 | 5000–30000 ms |
| frameAgeMs | 60000 | 1000–120000 ms |
| screenshotMaxDimension | 1280 | 320–1920 pixels |
| screenshotMaxBytes | 512000 | 32000–512000 bytes |
| visualCandidates.minRegionHeightPx | 32 | 24–256 JPEG pixels |
| visualCandidates.maxRegionAspectRatio | 8 | 1–32, width ÷ height |

Privacy and experimental-feature settings are documented in [PUBLIC-API](PUBLIC-API.md). Configuration never enables input without host authorization. Stopping or unloading revokes approvals; reopening does not restore stale frame permissions.

For optional minimized-RDP compatibility, use the explicitly invoked package script `lib/tools/Set-MinimizedRdpCompatibility.ps1`; see [MINIMIZED_COMPATIBILITY](MINIMIZED_COMPATIBILITY.md). Installation does not silently change the registry.

## Uninstall or rollback

Exit Harness, then run `dsh plugin --profile desktop remove dsh-plugin-virtual-desktop`. If you already have a trusted rc.1 tarball, retain it and its original checksum for rollback. After verifying the checksum, install that package with the same CLI's `add <rollback.tgz> --ignore-scripts`, reopen Harness and grant a new window authorization. See [RELEASING](RELEASING.md).
