# 外层 PiP 最小化后台运行

0.5.0-preview.2 保留子会话的后台点击、输入和定向滚动，并在建立 RDP 控件时设置及读回 IgnoreServerGeneratedMouseMoves=true，避免远端程序产生的鼠标位置更新传回主桌面。

RDP 另可能因预览最小化暂停图形输出；连接未断开不能证明画面仍在更新。兼容脚本只将当前用户 Registry64 的 Software\Microsoft\Terminal Server Client 下 RemoteDesktop_SuppressWhenMinimized 设为 DWORD 2，先备份原值。该值也可能影响同一用户新建的其它 RDP 客户端连接，后台渲染可能继续占用资源。它不修改 UAC、锁屏或其它安全设置。

先退出 PiP 与远程桌面客户端，在本包目录运行；替换备份路径为本机绝对路径，并保留备份文件：

~~~powershell
& ./lib/tools/Set-MinimizedRdpCompatibility.ps1 -Mode Enable -BackupPath 'D:/dsh-rdp-minimized-backup.json'
~~~

然后重新打开 PiP 连接。查看当前值使用 -Mode Status。回退仅恢复此单值，若用户已另行更改该值则拒绝覆盖：

~~~powershell
& ./lib/tools/Set-MinimizedRdpCompatibility.ps1 -Mode Restore -BackupPath 'D:/dsh-rdp-minimized-backup.json'
~~~

## 外层预览最小化验收

上述兼容设置仅适用于外层 PiP 预览最小化；内部目标仍需保持可见、未最小化。验收须分别检查预览 IsIconic、子会话关联、截图内容更新和实际输入结果；既有实机证据见 TEST_REPORT.md。

## 内部目标最小化与恢复验收

preview.11 增加 desktop_restore_window。内部目标最小化时截图返回 reason=minimized、nextTool=desktop_restore_window；调用时使用当前 connectionId、epoch、windowId 和 pid，不需要旧截图或 frameId。恢复独立授权并复核进程创建身份与子会话，成功后旧帧失效，须重新截图。窗口移动或缩放后新截图会自动重绑并明确提示，输入仍拒绝消费变化前的旧帧。

验收顺序为：最小化内部目标→读取结构化原因→恢复→新截图→核对 windowId/PID 不变→继续低风险操作。此项与外层预览最小化分别记录。本次受控 WinForms 实机结果见 TEST_REPORT_20261111.md，不代表所有自绘应用都兼容后台消息。

模型任务每步审批保持不变；如果显示“等待批准”，需在 Harness 面板审阅该动作。不能把消息投递成功或模型 finished 当成任务已经完成。

技术依据：[微软最小化 RDP 自动化故障说明](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/desktop-flows/ui-automation/uipi-issues#the-rdp-window-is-minimized-during-execution)、[微软支持页面中的当前用户注册表位置](https://learn.microsoft.com/en-ca/answers/questions/2196906/how-to-prevent-minimized-rdp-sessions-from-freezin)、[ActiveX 指针策略](https://learn.microsoft.com/en-us/windows/win32/termserv/imsrdpextendedsettings-property)。前两者建议的作用范围与客户端位数需区分；本包为 x64，脚本显式使用 Registry64 的 HKCU，不写全机 HKLM。

