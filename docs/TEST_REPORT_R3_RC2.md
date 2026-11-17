# R3 回归报告 · UIA 候选边界稳定性

## 改前

用户在已安装的 rc.2 中，对同一 VMware Workstation 窗口先后抓取图像帧和仅 UIA 帧。间隔小于一秒。两条实机回执的最小化按钮名称和候选 ID 一致，边界却不同。

| 模式 | 候选 | JPEG 边界 `(x,y,w,h)` |
| --- | --- | --- |
| image | `uia-35` | `(1112,18,52,6)` |
| uia | `uia-35` | `(1149,18,38,6)` |

左边界相差 37 px，宽度相差 14 px。回执没有稳定性标记。将用户提供的实机边界保存为 `tests/fixtures/uia-bbox-jitter-rc2.json`。改前运行 `tests/uia-bbox-stability.test.ts` 时，稳定性标记为 `undefined`，测试失败。见 `evidence/r3-bbox-before.log`。

## 改后

抓图后在同一个 Windows UIA 扫描中持有对应控件并采样边界两次，中间等待约 30 ms。标准标题栏候选另做两次 Win32 几何校准。两次读数都投影到当前 JPEG 坐标。位置、尺寸或边缘的最大变化超过 4 px，或者第二次边界不可核实，回执返回 `stable:false` 和 `bboxEvidence`。当后一次边界不可核实，`second` 与 `deltaPx` 为 null。

落入任一次观测边界的纯坐标点击会拒绝派发。拒绝回执带相同读数和 `nextTool`。拒绝仍消耗本帧的单次输入许可。对名称匹配且唯一的标准最小化按钮，工具可以重新校准有抖动的边界，并核验实际 `HTMINBUTTON` 后派发。其它 UIA 点击仍走原有名称、类型、窗口、授权和当前几何复核。任何候选 bbox 只在本帧内有效。

十帧回放使用上述实机样本注入抖动。两条边界的中心各触发一次坐标拒绝，`nextTool` 均为 `desktop_click_target`，且没有派发。最后一帧按名称调用，重新校准后得到 `HTMINBUTTON` 和 `WM_SYSCOMMAND/SC_MINIMIZE`。其余稳定帧的坐标点击照常派发。包含该用例的 31 项定向测试全部通过。见 `evidence/r3-bbox-after.log`。

2026-11-16 在专属 Windows 子会话中，通过实际 Cordis 工具交替抓取五张仅 UIA 帧与五张图像帧。十条回执的最小化候选均为 `stable:true` 和 `(1112,18,52,6)`，单次抓图耗时 1601–1769 ms。随后通过 `desktop_execute_action` 点最后一帧候选框的中心，收到 `outcome:"delivered"`、`HTMINBUTTON`、`WM_SYSCOMMAND/SC_MINIMIZE`，窗口实际最小化。测试子会话已清理，Windows 关联为空。证据见 `evidence/r3-bbox-live.json`。

两轮各十帧均未自然复现抖动。抖动拒绝路径依据用户提供的实机读数回放验证。首轮的稳定点击因未挂载图像附件服务测试替身而止于宿主检查，补齐替身后复跑通过。首轮证据保留在 `evidence/r3-bbox-live-first.json`。

## 重跑

```powershell
node --import tsx --test tests/uia-bbox-stability.test.ts
npm run build
node tests/uia-bbox-stability.live.mjs --allow-owned-vmware
```

实机探针拒绝接管已有 Windows 子会话。应用、截图和输入走已构建的桌面工具，模型及附件通道使用本地替身。截图像素不写入该证据回执。
