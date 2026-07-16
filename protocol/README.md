# Yimsg Protocol

`yimsg.proto` 是客户端与服务端协议的单一事实源。通用 Go 与 TypeScript protobuf 生成物分别位于 `generated/go/` 和 `generated/typescript/`；服务端专用分发代码保留在 `server/internal/ws/`，SDK 专用 Action/Notification 映射保留在 `packages/sdk/src/generated/`。

从仓库根目录刷新并校验：

```bash
go run ./tools/cmd/protocolgen
go run ./tools/cmd/protocolgen --check
```

协议层采用 `Apache-2.0`，详见 [LICENSING.md](../LICENSING.md)。协议设计和接口索引见 [docs/README.md](docs/README.md)。
