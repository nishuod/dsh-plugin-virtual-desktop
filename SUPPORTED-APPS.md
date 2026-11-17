# Application support

| Application | Adapter | Verification scope |
| --- | --- | --- |
| VMware Workstation 17 | `vmware` | rc.1 current executable readiness and identity verified; [external probe](docs/TEST_REPORT_EXTERNAL_APPS_RC1.md). Historical restore/list/start/stop checks remain separately documented in preview.13 |
| Repository-owned WinForms fixture | Generic | rc.1 real orphan reset followed by one ready open; named button click verified by UIA, screenshot and independent counter; [session report](docs/TEST_REPORT_SESSION_RECOVERY_RC1.md) |
| Notepad 11.2609.11.0 | Generic | rc.1 live `needs_review`: SDK UIA truncated; automatic readiness withheld; no editing tested |
| Calculator 11.2607.0.0 | Generic | rc.1 live `unknown` at capture (`DriverError.Tool`); no action success claimed |
| Other local `.exe` | Generic | Safe executable validation and verified process/window association; ambiguous or inaccessible UI returns `needs_review` |
| Shells, credential UI, main-desktop fallback | Denied | Not a supported workflow |

`ready` means the application window met the adapter's verification checks. It does not prove a later action succeeded. Inspect the receipt and fresh UIA/screenshot evidence after every action. An application with missing UIA controls can require reviewed image coordinates.

The only app-command channel is a fixed allowlist (currently VMware `vmrun`). There is no shell, arbitrary executable command, arbitrary argument passthrough or public third-party adapter registration in v1. The public adapter SDK belongs to v1.1.
