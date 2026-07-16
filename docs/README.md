# Yimsg 文档索引

> 主要对照：当前 monorepo 目录、各组件 README、根 README 与文档一致性检查工具。
> 最后复核：2026-07-16。
> 触发更新：组件目录、文档入口、维护边界或验证命令发生变化时同步更新。
> 入口关系：根目录 [`../README.zh-CN.md`](../README.zh-CN.md) 面向使用者；本文件负责跨组件文档导航。

## 文档分层

Yimsg 文档跟随代码所有权放置：组件专属文档与组件同目录，跨组件架构、部署和开发规范保留在根 `docs/`。历史过程资料统一进入 [`archive/`](archive/)。

```text
server/docs/             服务端架构、业务与数据库
protocol/docs/           协议治理、接口总览与生成速查
packages/sdk/docs/       SDK 设计、公开接口与 DataGateway
packages/uikit/docs/     UIKit 接入、UI 与渲染窗口
docs/architecture/       跨端架构与同步机制
docs/deployment/         部署方案
docs/development/        测试方案
docs/archive/            历史资料，不作为当前事实源
```

## 推荐入口

| 目标 | 文档 |
|---|---|
| 理解服务端 | [`../server/docs/README.md`](../server/docs/README.md) |
| 修改协议 | [`../protocol/docs/README.md`](../protocol/docs/README.md) → [`../protocol/docs/接口总览.md`](../protocol/docs/接口总览.md) |
| 使用或维护 SDK | [`../packages/sdk/docs/sdk接口说明.md`](../packages/sdk/docs/sdk接口说明.md) → [`../packages/sdk/docs/sdk设计方案.md`](../packages/sdk/docs/sdk设计方案.md) |
| 嵌入或维护 UIKit | [`../packages/uikit/docs/UIKit方案.md`](../packages/uikit/docs/UIKit方案.md) → [`../packages/uikit/docs/UI设计方案.md`](../packages/uikit/docs/UI设计方案.md) |
| 理解跨端同步 | [`architecture/同步机制方案.md`](architecture/同步机制方案.md) |
| 运行测试 | [`development/测试方案.md`](development/测试方案.md) |
| 部署 | [`deployment/部署方案.md`](deployment/部署方案.md) |
| 了解许可证边界 | [`../LICENSING.md`](../LICENSING.md) |

## 单一事实源

- WebSocket 帧与 protobuf：[`../protocol/yimsg.proto`](../protocol/yimsg.proto) 和 [`../protocol/docs/README.md`](../protocol/docs/README.md)。
- 接口矩阵：[`../protocol/docs/接口总览.md`](../protocol/docs/接口总览.md)。
- 数据库字段：[`../server/docs/db/schema字段对照.md`](../server/docs/db/schema字段对照.md)。
- SDK 公开 API：[`../packages/sdk/docs/sdk接口说明.md`](../packages/sdk/docs/sdk接口说明.md)。
- UIKit 挂载 API：[`../packages/uikit/docs/UIKit方案.md`](../packages/uikit/docs/UIKit方案.md)。
- 测试入口：[`../tools/run_all_tests.sh`](../tools/run_all_tests.sh)。

## 维护规则

1. 文档只描述当前实现；过期资料移动到 `docs/archive/`。
2. 仓库内引用使用相对链接，组件专属内容优先放在对应组件的 `docs/`。
3. 修改文档后运行 `go run ./tools/cmd/check-docs-consistency/`。
4. 修改代码后从仓库根目录运行 `./tools/run_all_tests.sh`。
5. 数据库 schema 或对外接口变更必须先征求确认；本次目录拆分不改变两者。
