# preview.13 VMware 应用命令验收

2026-11-11 记录首次实机问题，2026-11-12 复跑。使用 Windows 11 Pro x64、Workstation 17、Node 24.22.1、.NET 8 和真实 Windows RDP Child Session。探针调用 Cordis 工具入口、C# AppBroker 和真实 vmrun，权限预设由测试提供。

## 实机范围

探针使用应用目录解析的 Workstation 安装路径，在 PiP 内启动并绑定 VMware 主窗口。按已测截图坐标 `(1144,19)` 最小化目标，每次检查均要求截图返回 `reason=minimized`，同时保持连接、子会话、epoch、windowId 和 PID。电源操作只针对本轮新建并登记的临时 VMX，探针在每次派发前重新核对其目录、唯一标记和设备配置。测试 VM 无虚拟磁盘、ISO、网络、共享文件夹和外接设备。 [实机探针](../tests/vm-command.qa.ts)

| 轮次 | 改前行为与结果 |
| --- | --- |
| 11 月 11 日首轮，子会话 25 | `list` 成功。最小化期间 `start` 在 3996 ms 返回 `running`，同一 VMX 出现在列表和子会话进程证据中，VMX PID 2860、CPU 时间 718 ms。再次 `list` 见相同 PID 和 CPU 时间 1109 ms。`stop` 在 1057 ms 丢失回执，工具保守返回 `dispatch-unconfirmed`。VMware 记录已发起关机和 VMX 退出码 0，随后 Windows 记录 PiP broker 注销自有子会话。 工具回执 · VMware 日志 · 会话事件 |
| 11 月 12 日第二轮，子会话 2 | `list` 成功，`start` 在 3167 ms 丢失回执并使 PiP 结束。VMware 日志确认实际收到开机请求。这次故障出现在 `start`，与首轮 `stop` 一起保留为回归证据。 工具回执 · VMware 日志 |
| 11 月 12 日第三轮，子会话 3 | 受限权限下 `list` 成功，电源命令返回 `needs_authorization`。UNC 和穿越路径返回 `vmx-invalid-path`，同根内修改过的未登记副本返回 `vmx-not-allowlisted`。随后 `list` 在 373 ms 返回内层 `app-broker-disconnected`，诊断保留 `exchange/EPIPE`，PiP 控制连接仍能正常停止。 工具回执 |

## 回执传输复现与修复

Windows 在 `DisconnectNamedPipe` 时丢弃客户端未读数据。旧 AppBroker 把 JSON 和换行拆成两次写入，随后断开管道。改为单次写入完整回执行，并限时等待客户端读完后关闭连接。第三轮还暴露了读取器在监视读被取消时提前重置游标，重新读取到原请求并触发提前断开。游标现在只在读取成功后更新。主控制通道保留对真实连接失效的处理，应用管道断线返回可核对的未知结果，保留外层 PiP 并避免自动重放。 [Windows 管道文档](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-disconnectnamedpipe)

独立 Windows 管道探针让 Node 暂停读取 200 ms，并在每次写回执前取消服务端监视读。旧断开顺序 3/3 次返回 `read EPIPE`。保留旧游标时 3/3 次重新读到原请求，随后返回 `read EPIPE`。合并两项修复后，连续三个客户端 3/3 次收到完整 JSON 和换行，服务端均读到真实 EOF。该探针只建立本地测试管道。 输出 · 服务端 · 客户端

## 最终实机读回

11 月 12 日第四轮通过。父会话为 1，PiP 子会话为 4。所有电源操作期间，VMware 目标窗口维持最小化，截图检查始终返回 `reason=minimized`。在受限权限下，`list` 无审批通过，`start` 返回 `needs_authorization`。完全权限下的 never-ask 复跑没有弹出批准。UNC、`..\` 路径及同根未登记副本再次被拒绝。 最终回执

| 工具命令与实际参数 | 改后结果 |
| --- | --- |
| `vmrun.exe -T ws list` | 受限模式在 403 ms 返回已核实的空列表，完全权限在 324 ms 得到相同结果。 |
| `vmrun.exe -T ws start "<临时 VMX>" nogui` | 2809 ms 返回 `confirmed/running`，vmrun PID 40524，退出码 0。列表包含目标，`vmware-vmx.exe` 在子会话 4 的 PID 为 38100，CPU 时间为 578 ms。 |
| `vmrun.exe -T ws list` | 342 ms 再次核实同一个 VMX 和 PID，CPU 时间增至 921 ms。 |
| `vmrun.exe -T ws stop "<临时 VMX>"` | 1038 ms 返回 `confirmed/stopped`，vmrun PID 34460，退出码 0。列表和进程证据均为空。 |
| `vmrun.exe -T ws list` | 375 ms 独立复查，列表和进程证据仍为空。 |

电源循环结束后恢复 VMware，窗口 ID `a6090f01-fb7e-462c-9a88-29659ee0f1f9` 和 PID 13620 保持一致，截图成功，PiP 随后正常停止。 最终回执

## 构建与复跑

`npm run build` 包含 Typert、C#、Host/Client 打包及类型检查。C# 构建 0 警告、0 错误。`npm test` 全量 176/176 通过，含 VMX 规范路径和根目录边界、固定参数向量、错误码、operationId 去重、审批期间撤销、进程和会话绑定、取消及内外层管道隔离。`vmrun-missing`、`vmx-locked` 和 `timeout` 的回执由受控故障用例验证。 构建 · 全量测试 · [适配器测试](../tests/vm-adapter.test.ts) · [传输测试](../tests/vmware-command-transport.test.ts)

从仓库根目录构建，再用全新的证据目录执行实机测试。省略 `-PowerCycle` 只调用 `list`。指定 `-PowerCycle` 时脚本自己新建并登记临时 VMX。 [Windows 入口](../tests/Invoke-VmCommandQa.ps1)

```powershell
npm run build
npm test
& ./tests/Invoke-VmCommandQa.ps1 -EvidenceDir 'C:\temp\dsh-d6-list-qa'
& ./tests/Invoke-VmCommandQa.ps1 -EvidenceDir 'C:\temp\dsh-d6-power-qa' -PowerCycle
Push-Location ./evidence/preview13/pipe-repro
dotnet build
node ./repro.mjs
Pop-Location
```

本报告的实机操作范围为 `list`、`start`、`stop`。 `suspend` 和 `reset` 的实机动作未验收。用户现有 VMware 配置和虚拟机磁盘均未用于测试。
