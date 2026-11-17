# Changelog

## 1.0.0-rc.2 — 2026-11-16 (GitHub prerelease)

- Window restoration now returns verified geometry or a pending result with a screenshot retry hint. Capture still rebinds geometry changes and reports them through `notice`.
- Visual candidate extraction filters text-shaped regions before ranking and limiting results. The minimum JPEG-pixel height and maximum aspect ratio are configurable.
- The package manifest, lockfile and tarball filename identify this candidate as `1.0.0-rc.2`. The release directory includes checksums and the previous local candidate for rollback.
- Diagnostics, application receipts and the first record of each diagnostic log include the injected build identity when available.
- UIA candidates can report two bound samples and stability. Coordinate clicks refuse unstable targets and include evidence and a next tool.
- The UIA-only screenshot receipt points clients to image mode for visual proposals. Image mode includes explicit icon IDs within detected parent regions.
- Release candidates use the npm `rc` tag. See [release acceptance](TEST_REPORT_RC2_RELEASE.md) and the [20-scenario live evaluation](TEST_REPORT_EVAL_RC2.md).

## 1.0.0-rc.1 — 2026-11-14 (unpublished)

- Fixed owned standard EDIT background character keys and Ctrl+A selection; focused text replacement preserves selection with fixed Win32 messages. Identity changes and uncertain delivery never trigger SDK replay.

- Added owned child-session reset, orphan diagnostics, heartbeat recovery and terminal stop semantics.
- Added DPI-aware UIA password detection and configurable private regions/title matching. Production blocks whole sensitive frames and input because selective bitmap alignment remains unverified. Added redacted diagnostics and public privacy/security documentation.
- Added generic readiness evidence, internal adapter registry, UIA suggested targets and `desktop_click_target` with explicit fallback and verification evidence.
- Added bounded local logs, `desktop_export_diagnostics`, application state/timing, screenshot `mode` (`image`, `uia`, `changed`), platform failures and default-off experimental autonomous tasks.
- Prepared registry profiles, source-free executable tarballs (TypeScript declarations retained), checksum/rollback release workflow, English docs and community templates.
- Added exact tool schemas in [PUBLIC-API](PUBLIC-API.md),20 evaluation scenarios and benchmark scripts. See release acceptance for measured results and remaining gates; this candidate has not been published.
- 2026-11-15: added isolated tarball install/diagnostic verification to CI and release preparation, fixed single-line checksum parsing, retained current failed reports after eval cleanup errors, and corrected needs-review PID after executable handoff. Extended the owned live driver to fifteen scenarios; external app failures remain explicit.

## 0.5.0-preview.9 — 2026-11-10

- 子会话原生 AppBroker 在原登录环境启动应用，Node worker 保持独立的精简环境；管道核对认证值、请求号、桥接 PID 和 Windows 会话。
- 新增 desktop_open_application：单次请求建立 PiP、解析 VMware 安装位置、启动、验证主窗口、绑定和截图。面板调用同一服务。
- VMware 使用实际进程路径、VMUIFrame、响应状态、稳定窗口、菜单证据和非空截图判定 ready。错误或未知窗口不自动绑定；通用 exe 启动后需要人工核对。
- Full Access + never-ask 的窗口绑定和直接输入改为使用实时会话授权；撤销或连接改变拒绝派发。多步面板任务继续逐步确认。
- 重复请求保留结果，不重放启动；不确定结果在同一连接内阻止更换 ID 重启同一应用。


## 0.5.0-preview.8 — 2026-11-10

- 打开空 PiP 的结果明确返回 nextTool=desktop_launch_in_child_session。缺少目标窗口的报错也指引先启动应用，避免反复调用 start_task。
- 应用启动工具仅传 path 即可使用，operationId 可选并按本次工具调用 ID 生成。需要跨工具调用重试去重时，仍应显式复用回执中的 operationId。
- windowDiscovery.sdkSelection 通过原生 HWND 在内部比对 Win32 与 SDK 两次采样，报告 notCandidate、candidateNotInRaw 及未入选项的观察状态。状态计数与 SDK 内部过滤原因明确区分，不将未知项推断为 cloaked。

## 0.5.0-preview.7 — 2026-11-10

- 新增 desktop_launch_in_child_session，在已核实的 PiP 子会话启动本地 .exe，无需已绑定窗口。完全权限且从不询问使用当前会话授权，其他允许询问的模式请求单次批准。
- 面板新增「在 PiP 启动应用」入口。绑定与输入授权保持独立。
- 启动不接受参数、脚本、快捷方式或网络路径，不使用 shell 或主会话回退。核验创建进程所属会话，operationId 在本次连接内去重，拒绝过期连接和代次。
- desktop_get_windows 新增可选 includeDiagnostics，返回窗口列表及诊断。windowDiscovery.systemSurfaces 给出系统候选的进程、标题及过滤依据。
- 验证从零应用窗口启动 WinForms 应用，随后发现、面板绑定、聊天读回和取得非空截图。创建进程回执与窗口就绪分别报告。

## 0.5.0-preview.6 — 2026-11-09

- PiP 面板和诊断工具显示实际顶层窗口数、SDK 候选数、过滤原因和可授权窗口数。空列表时指引在 PiP 内打开应用。
- Host 为每次连接分配独立 connectionId。新连接和授权代次可独立核对。

## 0.5.0-preview.5 — 2026-11-09

- 面板自动发现当前连接的窗口，按会话区分候选，并显示执行器确认的绑定与代次。
- PiP 窗口列表过滤 Windows 桌面外壳、任务栏、开始、搜索和输入界面，保留普通应用窗口。
- 验证聊天打开 PiP 后，面板授权可由聊天状态立即读回，并取得绑定窗口截图。

## 0.5.0-preview.4 — 2026-11-09

- PiP 启动读取当前 Harness 会话的有效权限。「完全权限」且「从不询问」时直接启动，允许询问时使用单次批准。
- 启动前复核直接启动的权限。诊断报告 childStartPermission，并根据会话策略指引目标窗口授权。

## 0.5.0-preview.3 — 2026-11-09

- 增加 desktop_open_child_session 和 desktop_select_window，聊天可在 Harness 单次批准后打开 PiP、发现并绑定目标。
- 连接与窗口绑定分别审批，复核会话、代次和目标身份；没有本机回退。
- 诊断返回实际桌面状态和下一步工具，避免未连接时只能反复提示去面板授权。
- 修复 Zod JSON Schema 附带非 JSON 元数据导致 Harness 工具列表投影失败的问题。
- 保留 0.5.0-preview.2 的外层 PiP 最小化兼容与主鼠标位置隔离修复。

## 0.5.0-preview.0 — 2026-11-08

- 增加 Windows 画中画子会话试验入口。选定窗口后使用原有观察、逐步批准和独立验收流程。
- 校验管道和目标窗口的 Windows 会话身份。关闭预览时停止执行并使旧审批失效。
- 画中画支持左键单击、文本输入和垂直滚动。

## 0.4.0-preview.0 — 2026-11-08

适配 Harness 0.2.2-rc.1。增加单窗口任务循环、图像模型选择、逐次批准、新截图验收、任务预算和执行记录。暂停与终止会废弃正在等待的提案，继续从新观察规划。

## 0.3.0-preview.0 — 2026-11-01

新增本机 Windows 执行器、独立 worker、截图裁剪压缩、八类单步动作和面板。加入身份绑定、单次帧、跨进程租约、去重、暂停排空和终止撤权。模型工具使用宿主图像附件与逐次批准。修复 DPI 截图截断、不可见边框鼠标偏移、并发 pause/stop 和断连状态问题。33 项测试及受控 Windows 动作验证通过。

按用户选择先完成本机版，虚拟机与自主任务仍待后续。

## 0.2.0-phase2.1

修复真实 Desktop 缺少 computerUse 依赖。原生诊断面板和进程通信通过，只有诊断。

## 0.2.0-phase2.0

初始插件、Remote、诊断 worker 与循环协议参考实现。
