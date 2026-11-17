# Windows 桌面任务架构

DSH Host tools/Remote → NativeSession → 私有 IPC → 固定 native-worker → cua-driver Windows SDK。Koffi 提供身份预检、桌面状态、输入租约、独立进程 DPI 配置及明确批准的鼠标移动；Sharp 裁剪压缩截图。没有网络 worker endpoint。

画中画模式在 NativeSession 与原有执行器之间增加 WinForms 预览代理和子会话桥接。代理用 Windows RDP 回环建立 Child Session，以一次性本机管道连接其执行器。桥接和宿主分别约束动作投递。宿主只在会话握手完成后公布会话 ID，断线会撤销面板中的旧观察与审批。

0.5.0-preview.1 的子会话 worker 通过固定启动参数启用专用后台滚动原语；本机 worker 仍走原有 SDK。屏幕坐标从裁剪/缩放截图和 capture bounds 逆变换，检查已授权窗口客户区及同 PID/会话的子控件后，用 SendMessageTimeoutW 定向发送一次 WM_MOUSEWHEEL。超时不重试，成功仅说明消息已处理，不保证应用响应。该路径不依赖最小化预览后的 SendInput；不修改 RDP 注册表或系统安全设置。

Win32 语义依据：[WM_MOUSEWHEEL](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mousewheel)、[SendMessageTimeoutW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeoutw)。真实兼容性由受控最小化回归报告限定。

## 授权和生命周期

初始 disabled。Host 所有者可通过面板开启观察和选择窗口。聊天启动读取调用会话的权限预设、有效沙箱模式和审批策略。三者分别为 danger-full-access、danger-full-access 和 never 时直接启动 PiP，执行前复核这三项。允许询问时使用 Harness 的 allowed-once。desktop_select_window 独立请求单次批准，仅绑定已核实的 PiP 子会话。批准前后复核模式、状态、代次、两会话 ID 和窗口身份。进程创建时间、PID、精确 HWND 绑定身份，公开 ID 为随机 UUID，原始 HWND 以 BigInt 保留。

选择窗口获取跨进程互斥租约。一次仅接纳单个动作，不排队，operationId 防止重复执行。帧单次消费，检查 epoch、年龄、位置、焦点和进程身份。桌面全屏观察帧不能用于输入。

pause/stop 先关闭接纳并提升 epoch，再取消并等待动作和截图排空，关闭 SDK，释放租约。并发 stop 升级 pause。继续需要新截图，终止撤销窗口许可。取消不承诺回滚。

子进程仅收到必要 Windows 环境变量，不传模型凭据。严格 IPC schema、UUID 与 2 MiB 上限；3 秒心跳，15 秒失联回收。断连或协议故障不自动重启和重放。

## 图片和坐标

独立 worker 在 SDK 创建线程前启用每显示器 DPI 感知。服务端保存裁剪/缩放变换，将图片坐标逆映射到原始图像。移动鼠标使用 SDK capture bounds，避免将不可见窗口调整边框算入坐标。

窗口截图检查身份、frame valid 和采集前后位置。JPEG 默认长边 1280、最大 512000 字节，UIA 文本最多 12000 字符。裁剪以原始截图像素为单位。图片和 UIA 内容均为不可信数据，不能改变授权。

preview.11 的每张真实截图附带 scale（SDK 源图/裁剪尺寸与最终 JPEG 尺寸），输入仍只在 NativeRuntime 做一次逆变换。Host 在 %TEMP%/dsh-virtual-desktop/<connectionId>/<frameId>.jpg 保存 JPEG 并返回 filePath；直接工具使用宿主 saveImage 的原生附件引用，失败保留原错误。任务路径使用相同文件；stop/断线完成后清理连接目录。

desktop_restore_window 不消费截图，独立批准并绑定 connectionId/epoch/windowId/PID，worker 再检查进程创建身份和子会话归属。窗口最小化、隐藏、缩放、退出与身份变化分别返回 reason/nextTool；几何变化后的新观察自动重绑，旧帧继续拒绝。stop/start 经有界生命周期屏障，broker 等待自有子会话退出；等待超时给出 retryAfterMs，不重放未知输入。

## DSH 接入

Client 共享宿主 React/Cordis，通过官方 Typert 生成的 Remote codec 调用所有者方法。官方 MCP tool adapter 将图片接入 DSH 附件和工具结果持久化，没有另开 MCP 服务。

连接工具有 open_child_session 和 select_window；任务工具有 start_task、get_task_status、pause_task、resume_task 和 stop_task。单步工具有 get_windows、get_screenshot、execute_action、click、move_mouse、type_text、press_key 和 scroll。名称均以 desktop_ 开头。desktop_get_diagnostics 区分 diagnosticChannel 与真实 desktop，并返回 nextTool/guidance；连接前即可读取。

模型截图与输入前核实实际 Agent provider/model 的 image modality。每次输入请求 DSH approval，仅 allowed-once 通过。面板单步按钮代表用户审阅具体动作后直接授权。

## 任务循环

DesktopTasks 占用一个已授权窗口，驱动 loop-contract.ts 的观察、规划、执行和验收。DshTaskPlanner 使用宿主 LLM 服务的一次性请求与图像附件，仅向模型提供 propose_desktop_step。工具提案通过 schema 校验后进入面板批准。相对坐标映射回执行器的截图像素。

1. 截图或读取工具真实反馈。
2. 整理任务、近期操作与有界旧摘要。
3. 获取模型公开操作说明和结构化动作。
4. 严格解析后调用执行器。
5. 检查真实结果，重新观察。
6. 模型 finished 后获取新观察，由独立 evaluator 判 pass/fail/inconclusive。

每次批准绑定一张截图。派发前重新截图比较图像与控件树，发生变化时重新规划。明确拒绝的操作可在预算内重试，用户拒绝或投递未知时进入人工检查。暂停消耗中的模型提案失效，继续保留已用预算和近期回执。

验收使用新截图的控件值，或由用户检查目标状态。自动核对要求控件名称唯一、树完整且值可读。值不可读时转人工验收。确认期间画面变化会再次检查。

专用 DSH Session 记录插件日志，宿主的持久层负责落盘。进程重启后应重新授权并开始新任务。模型只提供公开操作说明。上下文由固定大小的近期回执与更早的事实摘要组成。

## VMware 应用命令

preview.13 的 desktop_vm_command 在已绑定 VMware Workstation 的 PiP 连接上执行。Host 沿用应用目录的注册表安装路径解析，检查可信 VMX 来源和允许根目录，并把 operationId、连接和窗口范围绑定在同一个请求中。Worker 在子会话内复核 HWND、PID 和进程创建身份，电源命令派发前使旧帧失效。目标窗口最小化期间使用同一身份检查。

子会话 bridge 通过现有 AppBroker 认证管道发送专用请求。AppBroker 在子会话原生环境从 VMware 安装目录选择 vmrun.exe，按白名单构造参数数组，并对进程和输出施加时间和长度上限。启动、停止、挂起分别核对运行列表和 VMX 进程，挂起再检查本次挂起状态文件。reset 回执可报告 VM 仍在运行，来宾重启无法独立验证时标记 unknown。

AppBroker 写出完整回执后，在有界时间内等待已认证客户端读取并关闭管道。该应用管道失败时，bridge 返回 unknown 和 transportError，保留控制连接以便重新读取状态。真正断开 PiP 后需重新打开并绑定 VMware 窗口。

preview.14 为已确认的只读运行列表返回 `state=listed` 和 `runningCount`。数量来自运行列表和同子会话进程的交叉核对。未确认的列表返回 `unknown`。诊断的 `desktop.activeBackend` 和 `desktop.capabilities` 描述当前连接，`pipProfile` 描述聊天建立 PiP 后支持的捕获范围。

窗口截图的 `accessibility` 记录 SDK 的可访问性读取状态。应用绘制的卡片和工具栏可能没有 UIA 名称，须用最新图像核对可见目标，仍按已绑定窗口、单帧及当前授权执行。

启用电源操作需由用户配置 vmAllowedRoots。vmInventory 可登记名称与绝对 VMX 路径，Workstation 清单和已核实的本子会话运行项也可用于解析。vmStartTimeoutMs 默认 90000，允许 30000 至 180000。vmStopTimeoutMs 默认 30000，允许 15000 至 60000。 [安全边界](SECURITY.md)
