# @yimsg/sdk

UI 无关的 Yimsg TypeScript SDK，包含 WebSocket transport、请求/响应封装、同步运行时、持久化 DataGateway、有界集合和公开事件/API。

```bash
npm run build -w @yimsg/sdk
npm run test:unit -w @yimsg/sdk
npm run test:integration -w @yimsg/sdk
```

## 文档入口

- [SDK 接口说明](docs/sdk接口说明.md)：公开 API、事件和数据类型。
- [SDK 设计方案](docs/sdk设计方案.md)：分层、会话运行时与同步边界。
- [DataGateway 接口](docs/DataGateway接口.md)：即时与持久化数据访问契约。
- [DisplayInfoCache 接口](docs/DisplayInfoCache接口.md)：展示信息缓存、失效和更新事件。

本组件采用 `Apache-2.0`。
