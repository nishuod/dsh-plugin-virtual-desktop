# Privacy

Applies to `1.0.0-rc.2`.

**Your screen content can leave this computer when Harness sends a screenshot or UI Automation text to the configured model provider.** This plugin has no separate screenshot-upload service or telemetry endpoint. Local observation in the owner panel does not itself call a model. A model tool result, an experimental task, the host's conversation history, or a user-shared diagnostic archive can carry observed content.

## Data flow

1. The owner authorizes observation and binds a verified application window. PiP capture stays in the verified Windows child session.
2. The worker collects the window bitmap and UIA information in memory. A fixed, local Windows UIA helper checks `IsPassword`, window identity and physical screen coordinates before and after capture.
3. In this candidate, any detected password region, any configured exclusion rectangle, a matching title blacklist, or an incomplete privacy scan blocks the **entire frame**. Every output pixel is overwritten with black before crop, resize, JPEG encoding, frame storage or attachment admission. UIA text and suggested targets are withheld, and the blocked frame cannot authorize input.
4. The host stores the processed JPEG locally. Screenshot tools admit it through Harness's attachment service. Harness determines whether it enters model context, which provider receives it, and how that provider and the host retain it.
5. Local logs and explicitly requested diagnostic ZIP files contain scrubbed metadata and, only when requested, recent processed frames. Export does not upload the archive.

Raw bitmap and UIA information exist transiently in worker/helper memory before redaction. The plugin does not intentionally persist the unprocessed bitmap. This is not a claim that Windows, the observed application, or third-party driver internals have no temporary storage.

## What masking covers

The helper scans the root control and its subtree, up to 2,000 elements and 256 password regions. It includes a root control whose own `IsPassword` property is true, requires the expected PID and establishes a DPI-aware context. However, matching UIA coordinates to physical HWND bounds does **not** prove that the screenshot bitmap uses the same pixel mapping. Live visual review found a displaced mask despite that coordinate agreement.

Production therefore uses a conservative whole-frame policy. A detected password or a configured exclusion rectangle returns `privacy.status:blocked` with `reason:sensitive-geometry-unverified`. A blacklisted title returns `reason:private-window-title`. Empty, oversized, failed or timed-out scans also block the entire frame. No input is allowed from these frames. Desktop-wide observation is fully obscured because a verified multi-window privacy mapping is not implemented.

This protects the output at a compatibility cost: an otherwise usable window containing a detected password, or any configured exclusion rectangle, becomes entirely unavailable for image-guided or UIA input. Selective region masking in real application bitmaps is **not** verified by this release. The low-level masking helper has a verified-projection mode for synthetic or independently verified bitmap producers; production tools and plugin configuration cannot enable it.

Configuration:

```json
{
  "privacy": {
    "excludedRectangles": [
      { "x": 100, "y": 100, "width": 300, "height": 80 }
    ],
    "windowTitleBlacklist": ["Password manager", "Private account"]
  }
}
```

Rectangle inputs use physical screen coordinates, including negative coordinates on secondary monitors. Up to 64 rectangles and 64 literal title substrings are supported. In the current production policy, configuring even one rectangle blocks the whole captured frame rather than relying on its projected position. Title matching is case-insensitive. Password detection depends on the application correctly exposing `IsPassword`; it cannot identify every secret shown as ordinary text, custom-drawn content or images. A successful scan is not a general sensitive-content classifier.

The title blacklist controls screenshot/UIA-frame disclosure. It does **not** hide window titles, application names, PIDs or other discovery metadata from the authorized window list or runtime status. These records, task goals and ordinary UIA text can themselves be sensitive.

## Local locations and retention

| Data | Location | Retention and cleanup |
| --- | --- | --- |
| Processed JPEG frames | `%TEMP%\dsh-virtual-desktop\<connectionId>\<frameId>.jpg` (Node's temporary directory) | Kept for the connection. Normal stop/close drains writes and removes its directory. Cleanup failure or process crash can leave files; no time-based orphan-frame sweeper is promised. |
| Child-session working/ownership files | `%TEMP%\dsh-child-session-*` | Normal owned-child teardown removes them after association cleanup. Failed cleanup retains ownership evidence for a retry. Never remove or reset an association that cannot be proven to belong to this plugin. |
| Diagnostic logs | `%LOCALAPPDATA%\dsh-virtual-desktop\logs\` | Each host instance has one current JSONL file and up to two rotated files. Rotation occurs above approximately 1 MB per file, plus a bounded final entry. No age-based retention or global cross-instance size cap is implemented; files remain until manually deleted. |
| Diagnostic ZIP exports | `%LOCALAPPDATA%\dsh-virtual-desktop\exports\diagnostics-<UUID>.zip` | Created only by export. Retained until manually deleted; stop does not delete an export already requested. |
| Recent export frames | Host memory, maximum five frames | Used by export only if each frame carries privacy metadata. The ring is cleared by stop/reset. Default export uses `recentFrames:0`; explicitly request 1–5 to include images. |
| Harness attachments, conversations, provider requests | Host/provider-managed storage | Outside this plugin's cleanup authority. Stopping the plugin does not delete already admitted attachments, chat history or provider copies. Use the host/provider's own retention and deletion controls. |

The `LOCALAPPDATA` fallback is the current user's `AppData\Local` directory. Paths shown by the runtime are authoritative if Windows redirects these locations.

## Logs, receipts and sharing

Diagnostic copies redact recognized secret keys, `vmrun -gu/-gp` values, password/token/secret-style arguments and usernames in Windows `Users` paths. Values used for execution and authorization remain unchanged internally. Pattern-based redaction does not prove that arbitrary application text contains no secrets.

An operational `filePath` or `read_image.file_path` may preserve the actual username so the local file remains usable. A diagnostic ZIP's returned local path is likewise usable as returned. Treat these paths as personal metadata. A ZIP includes the runtime/task snapshot, current-host log files and the number of requested recent frames; review it before sharing. An exported SHA256 proves byte identity, not absence of private information.

See [security](SECURITY.md), [public API](docs/PUBLIC-API.md) and the [privacy test report](docs/TEST_REPORT_PRIVACY_RC1.md).

