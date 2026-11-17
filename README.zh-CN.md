# dsh-plugin-virtual-desktop

[English](README.md) · 简体中文

面向 **DeepSeek Harness** 的 Windows 桌面执行层，支持审计和更换模型。插件在 Windows 画中画（PiP）子会话中打开并核验应用窗口，提供截图和 UI Automation（UIA）信息，并为每次授权操作返回证据和失败原因。

[GitHub 发布 v1.0.0-rc.2](https://github.com/nishuod/dsh-plugin-virtual-desktop/releases/tag/v1.0.0-rc.2) 是预发布版本，请下载 `.tgz` 安装。软件包及 `rc` 标签尚未发布到 npm。[发布验收](docs/TEST_REPORT_RC2_RELEASE.md)

## 安装与验证

使用启用了 Windows 子会话的 Windows 11 Pro x64、DeepSeek Harness `0.2.2-rc.1`、Node.js `>=24.9` 和 .NET 8 Desktop Runtime x64。Windows 10 x64 是目标平台，实机验收仍待完成。参见[平台支持矩阵](docs/SUPPORTED-PLATFORMS.md)和[安装指南](docs/INSTALL.md)。

1. 从[发布页](https://github.com/nishuod/dsh-plugin-virtual-desktop/releases/tag/v1.0.0-rc.2)下载 `dsh-plugin-virtual-desktop-1.0.0-rc.2.tgz` 与 `SHA256SUMS`，放在同一个目录。退出 Harness，在下载目录打开 PowerShell。如果 PATH 中没有 `dsh`，请使用 Harness 自带的 CLI。

   ```powershell
   $name = 'dsh-plugin-virtual-desktop-1.0.0-rc.2.tgz'
   $archive = (Resolve-Path -LiteralPath $name -ErrorAction Stop).Path
   $entry = Get-Content -LiteralPath 'SHA256SUMS' -ErrorAction Stop |
     Where-Object { $_ -match ('^[0-9a-f]{64}\s+' + [regex]::Escape($name) + '$') }
   $expected = $entry -split '\s+' | Select-Object -First 1
   if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256 -ErrorAction Stop).Hash -ne $expected) {
     throw 'Release checksum does not match SHA256SUMS.'
   }
   dsh plugin --profile desktop add $archive --ignore-scripts
   ```

2. 重新打开 Harness，在「插件」中启用 `dsh-plugin-virtual-desktop`。打开「虚拟桌面工具」，选择 Windows 子会话后端，按提示授权启动画中画。

3. 调用 `desktop_get_diagnostics`，查看 `plugin.version`、`plugin.buildHash` 和 `plugin.builtAt`。如果安装了 VMware Workstation，用 `{"appId":"vmware-workstation"}` 调用 `desktop_open_application`。打开其他允许的应用时，传入可执行文件的绝对 `path`。目标窗口就绪且已授权后，调用 `desktop_get_screenshot` 取得新帧。按[快速入门](docs/QUICKSTART.md)可以完成一次授权点击和结果验证。

只要 profile 仍引用这个安装包，就将它保留在原安装路径。使用其他 profile 时替换命令中的 `desktop`。需要回退时，退出 Harness，核对自己保留的 rc.1 安装包与可信的校验值，然后在该安装包所在目录运行以下命令。

```powershell
$rollback = (Resolve-Path -LiteralPath 'dsh-plugin-virtual-desktop-1.0.0-rc.1.tgz' -ErrorAction Stop).Path
dsh plugin --profile desktop add $rollback --ignore-scripts
dsh plugin --profile desktop list dsh-plugin-virtual-desktop --depth 0
```

列表应显示 `dsh-plugin-virtual-desktop@1.0.0-rc.1`。重新打开 Harness 后，需要重新授权窗口。

## 功能

- **观察与操作。** 获取窗口截图和 UIA 信息，通过控件名称或视觉候选定位，查看动作回执。每帧最多授权一次输入。自绘控件需使用图像模式。纯 UIA 模式不传像素，也不返回视觉候选。
- **应用与会话管理。** 打开和恢复已核验的窗口。窗口移动或缩放后可以重新绑定。插件可以清理已确认归属于自己的残留子会话。VMware Workstation 17 有专用适配器，通用应用可能需要人工复核。[应用支持](docs/SUPPORTED-APPS.md)
- **故障诊断。** 查询连接状态和运行中的构建标识，查看结构化错误原因，按需导出本地诊断 ZIP。[公开 API](docs/PUBLIC-API.md)

Harness 决定将截图或 UIA 文本发给哪个模型。根据所配置的模型提供方，这些内容可能离开本机。命中密码框或隐私排除规则，或隐私扫描未完成时，插件会阻止整帧和基于该帧的输入。子会话继续受 Windows 文件权限约束，保存到共享本地路径的文件在画中画关闭后仍可从主会话访问。[隐私说明](docs/PRIVACY.md) · [安全说明](docs/SECURITY.md)

`desktop_start_task` 是实验功能，默认关闭。应用命令仅允许固定的可执行文件与参数。公开 API 提供[工具 Schema](docs/PUBLIC-API.schema.json)和[回执 Schema](docs/PUBLIC-API.responses.schema.json)。

## 构建与贡献

在 Windows x64 上使用 Node.js `>=24.9` 与 .NET 8 SDK 构建。

```powershell
npm ci --ignore-scripts
npm run build
npm test
npm run verify:package
npm run release:prepare
```

`npm test` 运行自动化测试，不会向桌面发送输入。rc.2 的 Windows 实机评测记录为 20 项全部通过。`npm run eval` 默认列出评测目录。[评测指南](docs/EVALUATION.md) · [rc.2 实机结果](docs/TEST_REPORT_EVAL_RC2.md) · [贡献指南](docs/CONTRIBUTING.md) · [发布流程](docs/RELEASING.md)

项目采用 [MIT 许可证](LICENSE)。随包组件请参见[第三方许可声明](docs/THIRD_PARTY_NOTICES.md)。
