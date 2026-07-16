# Yimsg Server

Go 服务端入口位于 `cmd/yimsg-server/`，业务实现位于 `internal/`，服务端 E2E 与 seed 工具分别位于 `tests/` 和 `tools/`。

```bash
go run ./server/cmd/yimsg-server /path/to/config.toml
```

服务端采用 `AGPL-3.0-only`；架构与存储文档位于 [docs/](docs/)。
