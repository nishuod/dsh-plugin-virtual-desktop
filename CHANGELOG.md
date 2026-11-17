# 更新记录

## 1.0.0-rc.2 — 2026-11-16（GitHub 预发布）

- `desktop_restore_window` 在确认窗口离开最小化状态且几何有效之后，返回 `state:"restored",verified:true`。等待期满时返回 `state:"restoring"`、`retryAfterMs:200` 与截图入口。截图仍会在后续几何变化时自动重绑，并返回 `notice`。
- 视觉候选先过滤细长或过矮的文本样区域，再按原有置信度排序和数量上限选取候选。可配置 `visualCandidates.minRegionHeightPx` 和 `visualCandidates.maxRegionAspectRatio`。
- 同步包版本、锁文件、归档名和 semver 示例。发布准备核对归档身份和 SHA256，并保留上一版候选包用于回退。
- 发布候选使用 npm `rc` dist-tag。README 记录 tarball 安装和 rc.1 回退。registry 发布由账号权限阻塞，见 `docs/TEST_REPORT_RC2_RELEASE.md`。
- `desktop_get_diagnostics`、`desktop_open_application` 与诊断日志新增可选构建标识 `plugin:{version,buildHash,builtAt}`。
- UIA 候选记录同帧两次边界采样与稳定性。坐标输入拒绝命中不稳定区域，并返回证据和后续工具。
- `mode:"uia"` 明示自绘候选需切回 `image`。图像模式在父卡片内增加有明确 `parent` 的图标子候选。
- 更新 20 场景实机评测覆盖与逐条证据，见 `docs/TEST_REPORT_EVAL_RC2.md`。

## 1.0.0-rc.1 — 2026-11-14 (unpublished candidate)

- 新增幂等 `desktop_reset_child_session`、active/orphan/unknown 诊断、带归属证明的原生清理与 watchdog；stop 失败也撤销旧关联和许可，不终止其它进程或会话。
- 新增独立 UIA `IsPassword` 扫描、配置矩形和标题黑名单。实测发现物理坐标一致仍可能与 SDK 位图不对齐，因此生产环境遇到敏感区域、标题匹配或不完整扫描时整帧遮蔽并拒绝输入；不声称局部遮蔽已验收。日志/回执脱敏，补公开隐私说明和威胁模型。
- 通用应用通过稳定身份、正向图像和 UIA 证据判断 ready；内部适配器注册表保留固定动作/命令白名单。`accessibility.suggestedTargets` 提供原生 UIA 区域；`desktop_click_target` 按名称或帧内 ID 定位，显式坐标回退和事后变化写入 `evidence`。
- 新增本地滚动日志、`desktop_export_diagnostics`、应用状态/耗时展示。截图 `mode=uia|changed|image` 可减少发送像素；变化模式只抑制完全相同的帧。
- 针对已核验的标准 EDIT 控件补全后台 Enter/Backspace/Space 字符消息及 Ctrl+A 固定全选；已聚焦编辑控件的文本替换保留选择范围，避免再次点击后变成追加。每段消息重新核验焦点/身份，失败不重放，不新增前台或任意消息通道。
- `desktop_start_task` 标记 experimental，`experimentalTasks` 默认 false；非 Windows x64 执行器返回 `unsupported-platform`。
- 发布物收紧为编译产物、声明和文档，移除 source maps，增加 tarball 验证、SHA256、上一版回退包、Windows CI 和 tag 发布流水线。新增英文文档、协作模板、20 项评测目录及基准脚本。
- 公共参数/返回字段见 `docs/PUBLIC-API.md` 和生成的 JSON Schema。此候选包不代表 v1.0 全部验收完成：npm 发布/干净机安装、完整 20 场景 live eval、自绘控件视觉候选仍按发布报告追踪。
- 2026-11-15补充：候选tarball隔离npm安装/诊断验证纳入CI和发布准备；修复单行SHA256校验、评测清理失败仍保留旧报告、通用应用needs_review误报launcher PID。实机driver扩展至15项，外部应用就绪失败如实记录。
- 2026-11-16 补充：聊天和 owner Remote 的重置回执增加 `operationId,state,releasedPids`。同一 ID 安全重放，待处理请求和回执共用有界容量。重置仅释放本插件能证明归属的 Windows 子会话。
- 聊天回执使用可读的 `filePath`，并提供脱敏的 `filePathDisplay`。附件失败时 `nextToolArgs.file_path` 保持原始路径，日志和 ZIP 仍做脱敏。
- 后台动作回执新增 `sourcePoint,effectivePointSpace,hitTest,delivery`。最小化回执区分实际 Win32 命中和定向派发的系统命令。
- 对通过隐私检查的窗口客户区增加视觉区域候选、置信度、耗时和数量限制。视觉点击需要当前帧的精确 ID 和常规授权，回执记录点击前后截图哈希和变化区域。公开参数与返回记录均提供生成的 JSON Schema。
- npm 未发布。README 和安装文档给出当前可用的本地 tarball 安装及回退命令。

## 0.5.0-preview.14 — 2026-11-12

- 已确认的 VMware 运行列表返回 `state=listed` 和 `runningCount`。空列表用 `runningCount=0` 表示。
- 聊天诊断分别报告当前连接可用的能力与 PiP 连接支持的能力。未连接时没有活动后端或可用截图能力。
- 窗口截图附上 SDK 的 UIA 读取状态和无名按钮数量。对 VMware 等应用的自绘控件，使用最新图像核对可见目标。

## 0.5.0-preview.13 — 2026-11-12

- 新增 PiP 工具 desktop_vm_command，支持 VMware Workstation 的 list、start、stop、suspend 和 reset。
- 通过现有 AppBroker 在子会话内执行固定 vmrun 参数，并用运行列表、同会话 VMX 进程和相应状态证据核对结果。
- 新增 VMX 根目录、显式清单和启动、停止超时配置。电源操作独立核验会话权限和目标，重复 operationId 返回原回执。
- 工具支持明确选择 UI 降级。经核对可降级的失败提供新截图入口，并沿用现有 UI 输入审批。
- 修复 AppBroker 写回执后立即断开导致的读取竞态。应用管道故障有独立回执，PiP 控制连接继续提供只读核验。

## 0.5.0-preview.12 — 2026-11-11

- PiP 单击使用最新截图的像素。经 Win32 确认命中已授权窗口的最小化按钮后，定向投递最小化命令。动作回执记录 effectivePoint、sourceScale 和动作后窗口状态。
- 聊天工具经 Cordis 作用域查找附件服务。附件失败时回传 imageMode、UIA 树、JPEG 路径和 read_image 参数。
- 图像统计移入独立执行器，避免插件的 libvips 影响 DeepSeek 宿主的 Sharp 与 read_image。
- PiP 诊断和面板报告连接请求分辨率与 Windows 子会话的实测分辨率。

## 0.5.0-preview.11 — 2026-11-11

本次交付包含 preview.10 的 P0 修复范围，并增加 PiP 后台按键和双击；preview.10 未单独部署。

- D1：确认子会话原本已经经过 NativeRuntime 的截图逆变换，保留单次换算。真实帧补充 scale；1920×859 实机按截图坐标命中按钮。PiP 默认分辨率调整为 1920×1080。
- D2：增加 desktop_restore_window，独立批准并校验 connectionId、epoch、windowId、PID 和进程创建身份。区分五类窗口错误，移动或缩放后自动重绑，旧帧继续拒绝输入。
- D3：每帧 JPEG 保存到临时目录中的连接专属目录，工具回执携带 filePath。直接工具只调用一次宿主附件保存；失败保留真实错误码和原因，任务截图也保留文件。连接结束清理。
- D5：先关闭请求准入，再等待执行器、broker 和自有子会话退出。新连接有界等待；超时返回 retryAfterMs 与 nextTool，控制管道错误不再直接暴露 EPIPE。
- D4：后台 enter、esc、tab、backspace、方向键、space、home/end、pageup/pagedown、f5 及 ctrl+单字母；左键 count=2 投递双击消息。维持单帧、撤销及会话隔离检查。

完整改前/改后证据与适用边界见 docs/TEST_REPORT_20261111.md。D6 VMware appCommand 为可选项，本次未实现，未发布 preview.12。

## 0.5.0-preview.9

原生 AppBroker、统一应用启动和绑定、PiP 会话授权。上一版安装包保留，可用于回退。
