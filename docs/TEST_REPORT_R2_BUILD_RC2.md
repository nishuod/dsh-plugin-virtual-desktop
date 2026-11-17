# 回归报告 · R2 构建身份

验证环境为 Windows x64 和 Node.js。测试挂载真实 Cordis 工具注册及诊断 worker，使用隔离的构建目录和日志目录。应用启动用测试替身，负责验证开窗回执的编排及错误返回。复跑不打开 Windows 子会话或发送模型请求。

## 改前

给测试构建注入候选身份后，`desktop_get_diagnostics` 仍缺省 `plugin`。断言失败信息为 `diagnostics reply differs from its build identity`，并记录了实际 `undefined`。见 `evidence/r2-build-identity-before.log`。

## 改后

构建脚本读取包清单版本，并一次性生成 `{ version, buildHash, builtAt }`，作为常量交给打包器。短哈希以版本、构建时间和构建随机值为输入；归档完整性仍使用 `SHA256SUMS`。运行时使用编译后的值。从源码直接运行而未注入时，公开回执省略整个 `plugin` 字段。

实测两个分别打包并分别挂载的宿主，版本均为 `1.0.0-rc.2`，哈希分别为 `a6706cac7d78` 和 `2f3a0a994e0c`。对每个宿主重复调用诊断，并检查开窗成功和工具报错回执，`plugin` 字段与该宿主的构建标识完全一致。第三个未注入的宿主仍能调用这些工具，回执省略 `plugin`。时间使用 UTC 的 RFC 3339 格式。不同构建即使落在同一毫秒也拥有不同哈希。见 `evidence/r2-build-identity-after.log`。

从实际 `desktop_export_diagnostics` 返回的 ZIP 解析 JSONL。新日志及滚动后的日志第一行为 `event:"plugin-build"`，含同一组三个标识字段。原有诊断日志脱敏断言也通过。

## 重跑

```powershell
node --import tsx --test tests/build-identity.test.ts tests/release-observability.test.ts
```

4 项定向测试通过，Host TypeScript 类型检查通过。
