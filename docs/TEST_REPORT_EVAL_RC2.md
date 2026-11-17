# rc.2 Windows 实机评测

本报告摘录受控实机运行结果。原始诊断、日志及截图保留在测试环境。

## 改前证据

旧 runner 在 Windows 子会话中完成 15 条，跳过其余 5 条。跳过项为 Notepad、Calculator、VMware 列表、VMware 恢复及真实 HWND 被不同 PID 重用的情形。旧运行没有覆盖视觉候选、附件失败或密码遮蔽。逐项证据见 `evidence/rc1-eval-live.json` 及 [rc.1 报告](TEST_REPORT_EVAL_RC1.md)。

rc.2 保留 15 个已有用例，将原 Notepad、Calculator 和不可确定复现的 HWND 重用条目换成用户要求的视觉卡片、附件拒绝与隐私。原有身份变化和许可断言留在定向测试，原 Notepad 和 Calculator 的适配缺口也保留在 [外部应用就绪报告](TEST_REPORT_EXTERNAL_APPS_RC1.md)。

## 实机步骤

```powershell
npm run build
node scripts/build-eval-driver.mjs
npm run eval -- --driver artifacts/eval-live/driver.mjs --allow-owned-fixture --allow-owned-vmware --require-live
```

每条先检查没有已存在的 Windows 子会话关联，绑定本次进程、连接与子会话，再清理本用例拥有的会话。VMware 文件选择器只打开，未选择文件。VMware 命令只调用 `list`。视觉点击只在目标和同窗口客户区的截图通过已审阅的图像匹配后派发。附件失败用本地测试替身注入，生成与解码的是实机截图。基础用例使用实际子会话执行器和独立 fixture 状态，Cordis 工具用例采用单次许可测试替身。没有向模型发送截图或请求。

## 改后结果

2026-11-16 23:53（北京时间），Windows x64 完整实机运行 **20/20 通过，0 失败，0 跳过**，覆盖率与通过率均为 100%。`--require-live` 退出码为 0。累计用例耗时约 459 秒。清理后独立查询 WTS，子会话关联为空。

| 用例 | 结果 | 本次回执与独立证据 |
| --- | --- | --- |
| `basic-01-click` 命名点击 | 通过 | 每帧 UIA 唯一命中，独立计数 0→1，UIA 和 JPEG 哈希变化 |
| `basic-02-type` 输入 | 通过 | 空白输入框收到 `Fixture safe text` |
| `basic-03-clear` 清空 | 通过 | 分别用新帧发 Ctrl+A 与 Backspace，独立文本变空 |
| `basic-04-key` Escape | 通过 | Escape 计数 0→1，文本维持原样 |
| `basic-05-enter` Enter | 通过 | Enter 计数 0→1，文本出现换行 |
| `basic-06-replace` 替换 | 通过 | Ctrl+A 后输入，独立文本变为 `Fixture replacement` |
| `basic-07-scroll` 滚动 | 通过 | 滚轮计数上升，列表偏移 0→360，首行位置、UIA 和图像变化 |
| `basic-08-double-click` 双击 | 通过 | 受控色块的双击计数 0→1 |
| `app-09-visual-card` 自绘卡片 | 通过 | 当前帧三张卡片，审阅图像匹配，精确 ID `visual-0` 打开同 PID 的「打开」对话框，回执含变化区域与前后图像哈希 |
| `app-10-attachment-fallback` 附件兜底 | 通过 | 注入 `EVAL_ATTACHMENT_UNAVAILABLE`，回执 `imageMode:"unavailable"`，`filePath` 与 `read_image` 参数相同，JPEG 解码为 882×670 且字节等于被拒附件 |
| `app-11-vmware-list` 命令清单 | 通过 | `status:"confirmed"`、`state:"listed"`、`runningCount:0`，同子会话 VMX 交叉核对为空 |
| `app-12-vmware-restore` 最小化与恢复 | 通过 | 命名点击 `HTMINBUTTON/SC_MINIMIZE`，截图因最小化被拒。恢复返回 `restored/verified` 与 `(128,128) 1359×859`，同一窗口 ID/PID 取得新帧 |
| `app-13-generic-ready` 通用就绪 | 通过 | fixture 应用 `ready`，命名点击后计数 0→1 |
| `app-14-image-fallback` 显式坐标兜底 | 通过 | UIA 名称未找到，回执记录显式坐标回退，计数 0→1 |
| `failure-15-minimized` 最小化拒绝 | 通过 | 回执原因 `minimized`，独立计数和文本未变 |
| `failure-16-resized` 几何变化重绑 | 通过 | 运行动作返回 `request-failed` 并拒绝旧帧，新帧 982×710 带自动重绑 `notice` |
| `failure-17-orphan` 孤儿恢复 | 通过 | 杀掉本用例 broker，关联仍为 34，新连接被拒。重置工具返回 `releasedPids:[38944]`，关联清空 |
| `failure-18-revoked` 撤权拒绝 | 通过 | 先暂停并撤权，旧操作以 `request-failed` 被拒，仍为原连接且处于暂停状态 |
| `failure-19-reused-frame` 单帧一次 | 通过 | 新 operationId 重用同一帧返回 `request-failed`，第二次计数保持不变 |
| `failure-20-privacy` 遮蔽拒绝输入 | 通过 | 实机发现密码区域，回执 `blocked`，UIA 和候选隐藏，全部像素为黑。尝试输入被拒，计数保持 0 |

原始逐条结构化回执在 `evidence/rc2-eval-live.json`，退出结果在 `evidence/rc2-eval-live.log`。三条观测类用例分别核对可读 JPEG、只读命令和恢复回执，并保留两次观测。派发输入的用例继续核对 UIA 与 JPEG 哈希变化。

本轮没有失败或跳过项。后续适配计划仍跟踪旧版外部应用就绪报告中的 Notepad、Calculator 缺口，真实 HWND 被不同 PID 重用的条件也仍需专用的可控复现方法。
