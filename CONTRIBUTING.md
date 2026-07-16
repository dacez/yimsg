# 贡献指南 / Contributing

感谢参与 Yimsg。提交变更前，请先阅读 [AGENTS.md](AGENTS.md) 中的项目不变量、文档同步规则和全量测试要求。

## 许可证

提交贡献即表示你有权提交相关内容，并同意贡献按目标目录当前适用的许可证提供：

- `server/**`、`apps/web/**`：`AGPL-3.0-only`。
- `protocol/**`、`packages/sdk/**`、`packages/uikit/**`、`website/**`：`Apache-2.0`。
- 其它路径以 [REUSE.toml](REUSE.toml) 和 [LICENSING.md](LICENSING.md) 为准。

不要提交来源不明、许可证不兼容或无法保留其必要声明的第三方内容。

## 开发检查

代码变更应从仓库根目录运行：

```bash
./tools/run_all_tests.sh
```

文档变更还应运行：

```bash
go run ./tools/cmd/check-docs-consistency/
```

English: by contributing, you confirm that you have the right to submit the material and agree that it is licensed under the license assigned to its destination path. Run the repository-wide tests and documentation checks before submitting changes.
