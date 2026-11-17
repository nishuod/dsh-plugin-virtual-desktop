# Public API — 1.0.0-rc.2

This release candidate defines the intended v1 API. Generate [tool arguments](PUBLIC-API.schema.json), [response records](PUBLIC-API.responses.schema.json) and [visual candidate configuration](PUBLIC-API.config.schema.json) with `node scripts/export-public-api.mjs` after building. CI checks schema drift. Tools reject unknown input fields. Application-adapter registration remains internal until the 1.1 SDK release.

## Tools and inputs

| Tool | Inputs | Result |
| --- | --- | --- |
| `desktop_get_diagnostics` | `{}` | `diagnosticChannel`, `platform`, `desktop`, `pipProfile`, `childStartPermission`, `nextTool`, `guidance`, `completionPolicy`, optional `plugin` |
| `desktop_open_application` | Exactly one of `appId:"vmware-workstation"`, absolute local `.exe` `path`; optional UUID `operationId` | Application receipt below |
| `desktop_open_child_session` | `{}` | Child connection and discovered windows; never grants input by itself |
| `desktop_reset_child_session` | Optional UUID `operationId` | Reset receipt with `operationId,state,releasedPids` and stopped runtime state |
| `desktop_launch_in_child_session` | `path`, optional UUID `operationId` | `operationId,path,pid,outcome,message`; no arbitrary argv |
| `desktop_get_windows` | optional `includeDiagnostics` | Window array, or `{windows,windowDiscovery}` |
| `desktop_select_window` | UUID `windowId` | Runtime state |
| `desktop_restore_window` | UUID `connectionId,windowId`, integer `epoch,pid` | Verified restored window or a pending result with screenshot retry guidance |
| `desktop_get_task_status` | `{}` | Runtime state plus `childInputPermission,task` |
| `desktop_get_screenshot` | optional `source:window\|desktop`, `crop:{x,y,width,height}`, `mode:image\|uia\|changed` | Frame metadata and admitted image, or text-only UIA/unchanged observation |
| `desktop_execute_action` | UUID `operationId,frameId`, positive `epoch`, `delivery:background\|foreground`, discriminated `action` | Action receipt and fresh observation when available |
| `desktop_click` | Common action IDs/epoch, `x,y`; optional `button,count,delivery` | Action receipt |
| `desktop_click_target` | Common action IDs/epoch and `target:{id?,name?,controlType?,allowCoordinateFallback?}`. Optional `fallback:{x,y}` | UIA-first action receipt. Visual proposals require an exact current-frame ID. Coordinate fallback requires explicit opt-in and coordinates |
| `desktop_type_text` | Common action IDs/epoch, `x,y,text`; optional delivery | Action receipt |
| `desktop_press_key` | Common action IDs/epoch, `x,y,key`; optional modifiers/delivery | Action receipt |
| `desktop_scroll` | Common action IDs/epoch, `x,y,direction`; optional amount/delivery | Action receipt |
| `desktop_move_mouse` | Common action IDs/epoch, `x,y`; optional delivery | Action receipt; unsupported in PiP |
| `desktop_pause_task`, `desktop_resume_task`, `desktop_stop_task` | `{}` | Runtime state; stopping revokes input even if cleanup fails |
| `desktop_export_diagnostics` | optional integer `recentFrames:0..5`, default 0 | Local `filePath,filePathDisplay,sha256,frames,logWriteFailures` |
| `desktop_vm_command` | `appId:vmware-workstation`, UUID `operationId`, `command:list\|start\|stop\|suspend\|reset`, `vm` required except list, optional `fallback:ui` | Verified command receipt; fixed vmrun vectors only |
| `desktop_start_task` | Goal, acceptance and bounded task budgets, as specified by schema | Experimental task snapshot; disabled unless `experimentalTasks:true`; owner review remains required |

## Returned records

Runtime state: `backend`, `isolated`, `status`, `epoch`, nullable `window`, `foregroundAllowed`, `inputMode`, `lastResult`, `capabilities`; optional `connectionId`, `parentSessionId`, `childSessionId`, `pipDisplay`, `windowDiscovery`. Status is `disabled|observing|enabled|pausing|paused|stopping|stopped|failed`. Diagnostic-channel `ready` means IPC health, not permission to control a desktop. Unsupported native platforms return `reason:unsupported-platform`; diagnostics remain available.

`plugin` identifies the running build in both `desktop_get_diagnostics` and `desktop_open_application`. It contains `version`, a 12-character hexadecimal `buildHash`, and RFC 3339 `builtAt` in UTC. The build injects these values once. Source execution without the build step omits the object. The first JSONL record in each current or rotated log included in a diagnostic ZIP has `event:"plugin-build"` and the same `plugin` object. `buildHash` identifies a build and is independent of the release tarball's SHA256.

Window: opaque UUID `id`, `title`, `app`, `pid`, `x,y,width,height`; optional verified `imagePath,windowClass,responsive`. IDs, PIDs and epochs never authorize across connections. Receipts redact diagnostic usernames in paths; executable authorization compares original paths internally.

Restore receipt uses `state:"restored",verified:true,nextTool:"desktop_get_screenshot"` plus runtime state and a verified `window` on success. Its rectangle is in physical screen pixels and must fit within the virtual screen. Windows compositor bounds may exclude invisible resize borders. Screenshot `visualCandidates.clientArea` describes the client area in JPEG pixels, after projection, scaling and cropping. Restoration waits up to 1500 ms for usable geometry, polling at intervals of up to 50 ms. If it is still pending, the tool returns only `{state:"restoring",retryAfterMs:200,nextTool:"desktop_get_screenshot"}`. Wait for the hint before requesting a fresh frame. Old frames remain invalidated, and capture reports later geometry changes with the automatic rebind `notice`.

Reset receipt includes `state:"idle",releasedPids:[]` when there is no owned cleanup to perform. Successful owned cleanup returns `state:"released"` with the broker PIDs this plugin retained and confirmed clean. A broker may have exited before its stale association was released. The tool accepts no PID or session selector. Concurrent calls share teardown, and a retry with the same `operationId` returns the cached receipt for this host without affecting a later connection. If omitted, chat derives the ID from the tool call. The owner panel remote accepts an explicit operation ID.

Application receipt: `operationId,status,stage,path,message`, optional `connectionId,childSessionId,epoch,pid,window,reused,pipDisplay,filePath,filePathDisplay,scale,nextTool`. Status: `ready|needs_review|app_error|instance_conflict|timed_out|unknown`. Ready requires stable process/window identity, positive visual evidence and adapter UIA evidence. VMware has specific menu evidence; generic applications require nontruncated UIA controls. Ambiguous windows never auto-bind.

When a result includes a verified bound window (`ready` or post-capture `needs_review`), `pid` identifies that window's process. A launcher can hand off to another verified process of the same executable; the original launcher PID is not the input target. Pausing for review advances the epoch, so any attached earlier frame is observational and cannot authorize input after resuming.

Frame: `id,windowId,epoch,capturedAt,width,height,mimeType,source,tree`, optional `scale,visualContent,valueCheck,notice,privacy,accessibility,filePath,filePathDisplay`. Image bytes travel through the host attachment service. `imageMode:attachment|unavailable|uia-only|unchanged` describes delivery. A failed image admission can return `attachmentError,nextTool,nextToolArgs`. Crop input is in raw source image pixels.

| Screenshot mode | Pixels | Available target metadata |
| --- | --- | --- |
| `image` | Attachment or local `read_image` fallback | UIA and eligible visual proposals |
| `changed` | Attachment or fallback for a changed image. An identical image returns `imageMode:"unchanged"` | UIA and eligible visual proposals |
| `uia` | No pixels or image path. The runtime still checks privacy and frame authorization locally | UIA only. `note` reads `省流模式不含自绘控件候选；点击卡片等区域请改用 mode=image` |

`privacy`: `status:clear|redacted|blocked`, `passwordRegions`, `configuredRegions`, `titleMatched`, optional `reason`. Pixels are solid-overwritten before crop/resize/persistence. Production blocks the entire frame and input when password controls or exclusion rectangles exist, a title matches, or a scan is incomplete. UIA/HWND physical-bound agreement does not prove SDK bitmap alignment for all DPI modes; `sensitive-geometry-unverified` identifies this conservative fallback. Selective-region masking is not enabled in the production runtime. Text/targets are withheld with blocked pixels.

`accessibility`: `status:available|limited|unavailable`, `scope:window`, `treeTruncated`, `guidance`, optional `unnamedButtons,suggestedTargets,visualCandidates`. Targets have a frame-local `id`, `name` (possibly empty), `controlType`, JPEG-pixel `bbox`, `basis` and `crop` describing a region in the same JPEG. **Use a bounding box only with the frame that returned it. Fetch a new frame and use its coordinates after any capture, mode change, move or resize.** Similar IDs in different frames provide no continuity guarantee.

For a UIA target, `stable` reports agreement between two samples roughly 30 ms apart when checked. A change greater than 4 JPEG pixels on any dimension, origin or edge, or an unavailable follow-up sample, sets `stable:false` and adds `bboxEvidence:{first,second,deltaPx}`. The second box and delta are null if a second bound could not be verified. Pure coordinate clicks and coordinate fallback refuse points in either sampled unstable box. The action includes evidence and `nextTool:"desktop_click_target"` when the control can be selected explicitly. A targeted minimize still verifies the actual Win32 hit and permission. Other UIA targets retain revalidation of the matching authorized element and its current bounds.

Visual proposals use `basis:"visual"`, an empty name, `controlType:"region"` and `confidence` from 0 to 1. Parent rectangles use `id:"visual-N"`. Eligible high-contrast components of 16–64 JPEG pixels can appear as separate entries with `id:"visual-N.icon-M"` and `parent:"visual-N"`. The detector gives existing parents priority under the shared count and time limits, with up to three icons per parent. A click on a parent ID uses the parent region. Pass an icon's exact current-frame ID to select that icon's center. Shapes have no semantic label, and an app can handle an icon and its enclosing card as the same control. A proposal overlapping an equivalent UIA target identifies it with `shadowedBy` and remains observational.

`visualCandidates` reports `elapsedMs,truncated` and optional `reason,clientArea` in JPEG pixels. The detector runs on a privacy-cleared image of the verified window client area. A full budget timeout omits visual proposals and keeps UIA results. If only the optional icon search runs out of its time allotment, `reason:"icon-budget-exceeded"` identifies partial results. Image-aware callers must check a proposal against the image and pass its exact `target.id` under the existing input approval. Named input refuses ambiguous matches.

Action receipt includes `operationId,outcome:delivered|refused|unknown,message`, and a fresh observation when available. Text or UIA-only receipts use nullable `after`. Image receipts carry the observation fields at the top level and include `frameId`. Optional fields include `coordinates,sourcePoint,effectivePoint,effectivePointSpace,sourceScale,hitTest,delivery,postAction,evidence,visualVerification,nextTool`. Evidence entries have `channel:uia|visual|coordinates|verification`, `result` and optional `targetId,bboxEvidence`. Identical operation IDs replay the cached receipt without dispatch or a reusable frame.

`effectivePoint` is the point supplied to the executor. `effectivePointSpace` is `sdk-image-pixels` for SDK dispatch or `physical-screen-pixels` for native dispatch. `sourcePoint` is the inverse JPEG-to-SDK image projection, and `sourceScale` describes the input frame. `hitTest.point` uses window-relative physical pixels with `windowRelative:true`. The record also includes `screenPoint,windowOrigin,class,code` for the actual Win32 hit test. For a verified minimize button, `class:"HTMINBUTTON"` and `delivery:{kind:"WM_SYSCOMMAND",command:"SC_MINIMIZE"}` identify the routed system command. Its position is the physical screen point used for hit testing. Other delivery kinds have `command:null`. A hit test by itself does not establish successful delivery.

On Windows child sessions, standard UIA caption targets use bounds confirmed with the owned HWND. A minimize target must still report `HTMINBUTTON` immediately before the system command is sent. The executor refuses a changed or unverified hit for that target. The child-session title bar supports named dispatch for Minimize. Calibrated Maximize and Close targets are observational in this route.

For a visual click, `visualVerification` reports `targetId,beforeScreenshotSha256,elapsedMs` and, when recapture succeeds, `afterScreenshotSha256,changedRegion`. The bounds use screenshot pixels and are null when no pixel difference is measured. Use the hashes and region together with the resulting UI state to verify the effect.

Background keys in a verified standard Win32/WinForms EDIT control complete Enter/Backspace/Space with fixed `WM_CHAR` messages and Ctrl+A with fixed `EM_SETSEL(0,-1)`. Other control classes keep the key-message route and still require result verification. This does not expose arbitrary messages or bypass the existing key whitelist. See Microsoft's [WM_CHAR](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-char) and [edit text operations](https://learn.microsoft.com/en-us/windows/win32/controls/edit-controls-text-operations) for the underlying message semantics.

When `desktop_type_text` addresses the already focused standard EDIT control in an owned child session, it preserves the selection and sends a fixed `EM_REPLACESEL` with the validated text. It does not reclick and erase a preceding Ctrl+A selection. Target PID, session, root, focus, bounds and control class are rechecked. The existing SDK route is used only if this focused-control route sends no message and reports unsupported; refusal or unknown delivery never falls through or replays.

Failures include `error,reason,nextTool`, optional `retryAfterMs,association`. Child association is `active|orphan|unknown`; a proven orphan points to reset, an active child points to status. Reset cannot clear a legacy or foreign association without ownership proof. Failed tools never recommend themselves. Window reasons include `minimized|hidden|resized|exited|identity-changed`. Permission/frame validation failures retain `request-failed` unless a specific reason is available.

## Redacted fields

When a tool returns `filePath`, it is the real absolute local path for an image or diagnostics archive. Pass it verbatim to the local reader while the file still exists. Attachment fallback passes the same value as `nextToolArgs.file_path`. `filePathDisplay` is the scrubbed representation for presentation. A tool receipt can expose the account component of a local operational path to the configured chat model. Logs and diagnostic archives scrub that component even for operational paths. Other diagnostic path fields, messages, sensitive values in `argv` such as `vmrun -gu/-gp`, and fields such as `password`, `token` and `authorization` remain scrubbed in receipts, logs and exports. See [PRIVACY](PRIVACY.md) for retention and cleanup.

## Configuration and transport boundary

`experimentalTasks` defaults false. Privacy config accepts up to 64 physical-screen `excludedRectangles` and 64 case-insensitive literal `windowTitleBlacklist` substrings. `screenshotMaxDimension` is 320–1920 (default1280), `screenshotMaxBytes` 32000–512000 (default512000), and frame age 1000–120000 ms. JPEG quality adapts internally from75 downward to meet the byte cap. VMware roots/inventory and deadlines are described in SECURITY.md; neither adapters nor tools accept arbitrary commands or executable arguments.

`visualCandidates.enabled` defaults true, `maxCandidates` defaults to 8 (1–8), and `budgetMs` defaults to 120 (1–120). The text-shape filter drops a region when its height is below `minRegionHeightPx` (default 32, integer 24–256 in JPEG pixels) or its width divided by its height exceeds `maxRegionAspectRatio` (default 8, range 1–32). Filtering runs before confidence ranking and the count limit.

Owner-only panel Remote endpoints are implementation transport, not an external SDK. New endpoints in this candidate are `resetChildSession`, `exportDiagnostics(recentFrames)`, `applicationStatus`. The latter returns `status,stage,startedAt,elapsedMs,operationId` or null. Connection/PID/epoch validation, single-frame consumption, immediate revocation and no fallback to the main desktop remain mandatory across all surfaces.
