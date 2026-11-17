# rc.2 回归报告 · UIA 省流提示与视觉图标

## R4 省流提示

改前工具测试收到 `imageMode:"uia-only"`，但缺少说明，新增断言以 `undefined` 失败。日志在 `evidence/r4-uia-note-before.log`。

改后真实 Cordis 工具投影返回 `note:"省流模式不含自绘控件候选；点击卡片等区域请改用 mode=image"`。输出仍无像素、图像路径或视觉候选。回归验证文本模型即使手动提供视觉 ID 也无法派发。保留这条路径是为了沿用视觉输入的图像核对和当前授权。见 `evidence/r4-r5-visual-after-tests.log`。

## R5 卡片内图标

在此前已审核的 VMware 首页实际 JPEG 上离线回放，原实现保留三张卡片，但圆圈加号没有子候选，断言失败。见 `evidence/r5-icons-before.log`。

改后在相同 JPEG 内分离高对比度、边缘密集的连通区域，保持三个父框及其置信度，新增子候选。圆圈加号为 50 × 49 像素，置信度 0.928，其 ID 关联创建虚拟机卡片。探测后父框与原记录逐边差小于 3 像素，当前回放耗时约 47 ms，无截断。见 `evidence/r5-icons-after.log`。

审查时，只有 `OPEN VM` 文字的合成卡片误触发三个图标框。新增基线相近的连续字形过滤后，不再返回这些框。前后证据为 `evidence/r5-text-runs-before.log` 与 `evidence/r4-r5-visual-after-tests.log`。

执行路径测试分别提交父 ID 和子 ID。回执记录不同的目标和执行点。子图标受共享总上限约束，且无法借子 ID 绕过已被 UIA 覆盖的父区域。12 项定向测试通过。视觉检测根据形状提出区域，无法确认应用将图标视为独立按钮。VMware 图标证据来自实机图像回放，未点击创建虚拟机图标。

重跑命令：

```powershell
node --import tsx tests/visual-icons.replay.mjs
node --import tsx --test tests/visual-targets.test.ts
```
