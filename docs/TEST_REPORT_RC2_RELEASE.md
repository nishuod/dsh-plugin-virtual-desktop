# 1.0.0-rc.2 发布验收

基线为已安装的 rc.2 tarball，SHA256 以 `a10ef396f38c` 开头。后续候选的实际 SHA256 以其发布目录的 `SHA256SUMS` 为准。

## GitHub 发布验收

[GitHub 预发布](https://github.com/nishuod/dsh-plugin-virtual-desktop/releases/tag/v1.0.0-rc.2) 提供从公开源码构建的 Windows 安装包与 SHA256SUMS。该归档单独通过了包内容检查与本机隔离安装，详细构建标识见 Release 资产 release.json。受控 Windows 会话的 20 条实机结果来自上一份 rc.2 开发构建。

## npm 发布验收

公网 npm 的 `npm view dsh-plugin-virtual-desktop dist-tags --json` 返回 `E404`。同一 registry 的 `npm whoami` 返回 `ENEEDAUTH`，当前没有已登录的发布账号。证据见 `evidence/r1-npm-before.json`。本轮没有执行发布，`rc → 1.0.0-rc.2`、registry 版本和 registry tarball SHA256 暂无记录。

[README](../README.md) 记录当前可用的 tarball 安装和回退命令。项目的 [profile 示例](examples/desktop-profile/package.json) 已用 semver。现有安装保留本地来源，直到 registry 可用。同机隔离依赖安装用于校验实际归档和插件加载，无法替代新的 Harness profile 从 registry 安装。

本轮在 `artifacts/releases/r1-staged/1.0.0-rc.2/` 独立暂存，原 `desktop` profile 引用的归档不会被覆盖。正式候选的 SHA256、包内版本与从隔离安装诊断读出的 `plugin` 标识见该目录的 `release.json` 和 `SHA256SUMS`。打包日志见 `evidence/r1-release-prepare.log`，隔离安装回执见 `artifacts/install-smoke/latest.json`。

发布账号就绪后，执行 `npm publish <verified-tarball> --access public --tag rc --ignore-scripts`，确认 `npm view dsh-plugin-virtual-desktop dist-tags` 返回 `rc: 1.0.0-rc.2`。使用新建的 Harness profile，例如 `dsh plugin --profile vd-rc2-registry-smoke add dsh-plugin-virtual-desktop@1.0.0-rc.2 --ignore-scripts`。该 profile 应从空的插件依赖开始，按 Windows 桌面模板启用插件，然后依次记录：

1. `desktop_get_diagnostics` 核对诊断通道与 `plugin.version`、`buildHash`。
2. `desktop_open_application` 传 `{"appId":"vmware-workstation"}`，核对已授权窗口和 `ready`。
3. `desktop_get_screenshot` 核对与同一窗口和连接对应的截图回执。

将下载的 registry tarball SHA256 与发布前的本地归档校验值比对，并附上三步冒烟回执。候选发布使用 `rc`，稳定版发布另行走 `latest`。

相关改前与改后证据见 [R2 构建标识](TEST_REPORT_R2_BUILD_RC2.md)、[R3 UIA 边界](TEST_REPORT_R3_RC2.md)、[R4/R5 省流与图标](TEST_REPORT_R4_R5_RC2.md) 和 [R6 逐场景评测](TEST_REPORT_EVAL_RC2.md)。
