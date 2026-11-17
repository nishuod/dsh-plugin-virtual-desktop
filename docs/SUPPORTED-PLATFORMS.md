# Supported platforms

| Platform | Execution support | Evidence |
| --- | --- | --- |
| Windows 11 Pro x64 | Supported target | Historical preview.13 VMware tests; rc.1 owned-orphan recovery, 20 open/stop cycles and generic fixture named input tested; clean-machine installation pending |
| Windows 10 x64 | Target platform, acceptance pending | No Windows 10 live evidence in this checkout; do not represent it as tested |
| Windows ARM64 / x86 | Unsupported | Structured `unsupported-platform` result |
| macOS / Linux | Unsupported | Structured `unsupported-platform` result; no fallback executor |

Required: DeepSeek Harness 0.2.2-rc.1, Node >=24.9, .NET 8 Desktop Runtime x64 and Windows Child Sessions. Building requires the .NET 8 SDK. PiP remains subject to Windows edition and policy support; remote sessions are not a sandbox from the user's files.

See [installation](INSTALL.md), [rc.1 session evidence](TEST_REPORT_SESSION_RECOVERY_RC1.md) and [historical live evidence](TEST_REPORT_PREVIEW13_20261111.md). A healthy diagnostic worker is not proof that a desktop target is connected, authorized or ready.
