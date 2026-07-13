# 协议治理方案

> 主要对照：`internal/protocol/yimsg.proto`、`internal/protocol/pb/yimsg.pb.go`、`frontend/src/sdk/generated/yimsg.ts`、`internal/ws/connection.go`、`frontend/src/sdk/transport/`。
> 最后复核：2026-07-12。
> 触发更新：WebSocket interface、请求 / 响应字段、错误码、通知类型、SDK ↔ 服务端映射或协议生成策略变化时同步更新。
> 入口关系：上级索引见 [`../README.md`](../README.md)；完整接口矩阵见 [`../接口总览.md`](../接口总览.md)；本文负责协议一致性治理和代码生成规则。

## 1. 定位

Yimsg 的主协议是 WebSocket 二进制帧。protobuf 是协议的单一事实源：所有 `Type`、request、response、错误码和 notification 都先在 `internal/protocol/yimsg.proto` 中定义，再由 `go run ./tools/cmd/protocolgen` 调用标准 `protoc` 工具链生成 Go / TypeScript protobuf 类型。

协议只保留一种 body 编码：protobuf wire format。`codec` 字节只承载 endian、version 和保留位，只表达二进制帧字节序和协议版本。

## 2. 帧格式

```text
magic:uint8 + codec:uint8(bitfield) + reserved:uint8 + checksum:uint8 + size:uint16 + request_id:uint64 + type:uint16 + body
```

| 字段 | 说明 |
|---|---|
| `magic` | 固定 ASCII `M`，用于快速排除非 Yimsg 二进制帧 |
| `codec` | 位域，低位到高位分别为 endian、version、保留位 |
| `reserved` | 当前固定为 `0`；原独立 version 字节已改为保留位 |
| `checksum` | CRC-8 校验码；计算时把 checksum 字节视为 `0`，对完整 frame header + body 计算，参数为 poly `0x07`、init `0x00` |
| `size` | body 长度，必须是 `uint16`；协议整包上限 `0xffff` 字节，扣除 16 字节 header 后最大 `65519` |
| `request_id` | 请求匹配 ID；`0` 保留给服务端通知 |
| `type` | protobuf `Type` 数值；`0` 是无效值，业务请求与服务端通知共用同一个枚举空间 |
| `body` | protobuf wire format 的 request / response / notification body |

`codec` 字节按低位到高位解释：

| 位 | 含义 |
|---|---|
| bit0 | 0 表示 `size`、`request_id`、`type` 使用 big-endian；1 表示 little-endian |
| bit1-4 | 协议 version，当前为 1 |
| bit5-7 | 保留位，必须为 0；这 3 位与后续 `reserved` 字节连续，作为后续扩展区 |

服务端和 SDK 解码顺序是：先检查最小长度与整包上限，再检查 `magic`、`reserved`、`codec` 位域和 `size`，确认长度匹配后校验 CRC-8，最后读取 `request_id` 和 `type`。CRC-8 只用于发现截断、错位和常见传输损坏，不提供安全防篡改；安全边界仍依赖 TLS、鉴权 token 和业务权限校验。

`request_id=0` 表示服务端 notification，具体通知结构由帧头 `type` 决定；通知 `Type` 从 `10001` 起单独分段，避免和业务 action 连续挤占同一扩展区。客户端业务请求必须使用非 0 `request_id` 和已注册的业务 `Type`。除 `ErrorCode` 的 `0` 表示 `OK` 外，protobuf enum 的 `0` 都只能表示 invalid / reserved / error，真实业务枚举值从 1 开始。

## 3. Base 类型

`BaseRequest`（uid + request_id）不再出现在 protobuf 中，避免暴露给 SDK 影响协议简洁性。改为在 Go 服务端定义 `BaseInfo` 结构体，由框架层填充后传入每个业务方法：

```go
// internal/service/base_info.go
type BaseInfo struct {
    UID       int64
    RequestID uint64
}
```

业务方法签名统一为：

```go
func (s *AppState) Register(info *BaseInfo, req *pb.RegisterRequest) *pb.RegisterResponse
```

`BaseResponse` 仍保留在 protobuf 中，因为 SDK 需要解析响应错误码：

```proto
message BaseResponse {
  ErrorCode code = 1;
  string msg = 2;
}

message ExampleResponse {
  BaseResponse base = 1;
  int64 business_id = 10;
}
```

规则：

1. `uid` 和 `request_id` 由服务端 WebSocket 帧头解析后填入 `BaseInfo`，业务代码只读。客户端不应在请求 body 中传这两个字段。
2. `BaseResponse base = 1` 是唯一的通用返回状态位置，不能在每个 response 中重复定义 `code` / `msg`。
3. response 的业务字段从字段号 10 开始，字段号 1 保留给 base。
4. 后端错误码使用 protobuf `enum ErrorCode` 定义，运行时代码通过 protobuf 反射直接写入 `BaseResponse.code/msg`，不再经过 JSON 中间层。

## 4. 生成范围

`go run ./tools/cmd/protocolgen` 以 `internal/protocol/yimsg.proto` 为唯一事实源，先用 `protoc` 刷新 protobuf 类型，再由 `tools/protocolgen` 解析 proto 生成两端协议机械映射与协议文档。

| 生成目标 | 文件 |
|---|---|
| Go protobuf 类型与序列化代码 | `internal/protocol/pb/yimsg.pb.go` |
| TypeScript protobuf 类型与序列化代码 | `frontend/src/sdk/generated/yimsg.ts` |
| Go `ActionService` 接口（入方向） | `internal/ws/action_service_gen.go` |
| Go `DispatchActionFrame` 与 type 工厂 | `internal/ws/action_dispatch_gen.go` |
| Go 通知出方向 frame helper / `EncodeNotificationFrame` | `internal/ws/notification_frame_gen.go` |
| TS 出方向 action 无状态函数 | `frontend/src/sdk/generated/actions.gen.ts` |
| TS 入方向 `NotificationHandler` 与 `dispatchNotificationFrame` | `frontend/src/sdk/generated/notifications.gen.ts` |
| 协议接口表（自动生成，禁止手写） | `docs/generated/协议接口表.md` |
| 协议中间清单 | `docs/generated/protocol_manifest.json` |

生成边界：

- **Go 服务端**：action 是入方向，生成 `ActionService` 接口和 `DispatchActionFrame(svc, info, frame)`（type → request decode → service method → response encode → response frame）；notification 是出方向，生成 `NewXxxNotificationFrame` / `EncodeNotificationFrame`。
- **TS 客户端**：action 是出方向，只生成 `login(transport, req)` 这种无状态函数（不生成 class / interface）；notification 是入方向，生成 `NotificationHandler` 接口和 `dispatchNotificationFrame(handler, frame)`。
- **继续手写**：Go service 业务逻辑、SDK 公开接口、DataGateway、缓存、状态机；`msg_id` 仍只在 TS SDK 内部唯一生成点生成；fanout（异步任务队列）/ notify / DB 写入属于 service，不属于 dispatch。

生成器使用 `grpc-tools` 提供的 `protoc`、`protoc-gen-go` 和 `ts-proto`。`go run ./tools/cmd/protocolgen --check` 会重新生成全部生成物并与仓库内容逐字节比较，不一致即失败并提示重新运行生成器。新增 action 后若 `AppState` 未实现对应方法，Go 编译会因 `ActionService` 断言失败；新增 notification 后 SDK 内部 handler 未实现也会编译失败。

## 5. 修改流程

1. 修改 `internal/protocol/yimsg.proto`。
2. 确认 `frontend/node_modules` 中已有 `grpc-tools` / `ts-proto`，且本机可执行 `protoc-gen-go`。
3. 运行 `go run ./tools/cmd/protocolgen` 刷新生成物。
4. 同步服务端 dispatch、SDK transport、E2E 和前端单测。
5. 同步 `docs/接口总览.md`、本文和相关专题文档。
6. 从仓库根目录运行 `./tools/run_all_tests.sh`。

只读校验生成物是否最新：

```bash
go run ./tools/cmd/protocolgen --check
```

## 6. 一致性规则

1. 新增或修改核心接口时，先改 protobuf，再改实现。
2. `register`、`login`、`authenticate` 是免认证接口；其余核心接口默认需要认证。
3. SDK 对外仍使用业务友好的 camelCase 方法；wire 字段统一 snake_case。
4. `uid`、`friend_uid`、`to_uid`、`group_id` 等 int64 ID 在 SDK 对外类型中保持字符串，避免 JavaScript number 精度丢失；`msg_id` 是原生 string（UUIDv7 base64url，22 字符），由 SDK 生成。
5. 服务端失败响应必须通过 `BaseResponse.code/msg` 返回稳定错误码和可读信息。
6. 通知只表达“有变化”，客户端通过分页读取或 `sync_*` 接口主动追平。

## 7. 协议演进方向

1. 由 `protocolgen` 生成 Go / TypeScript 两端的 `Type`、request / response codec switch，减少手写映射漂移。
2. 在连接层补充协议指标：非法 magic、codec 保留位、reserved 非 0、版本不支持、checksum 错误、size mismatch、未知 `Type` 分开计数。
3. 设计版本协商或能力协商接口；当前 codec bit1-4 的 `version=1` 只能拒绝不兼容帧，不能表达灰度能力。
4. 评估是否需要更强校验：16 字节 header 下只能容纳 CRC-8；若未来需要更强链路完整性，应通过协议版本升级引入 CRC-16 / CRC-32 或认证摘要。
5. 补充 request_id 上限和溢出策略，前端长期连接达到 `uint64` 边界前应主动重连或重置会话。

当前已有跨语言 golden frame 回归：Go 测试 `internal/ws/golden_frame_test.go` 和 TypeScript 测试 `frontend/tests/unit/sdk/protocol-golden-frame.test.ts` 各自硬编码同一组样例常量（`LoginRequest` 的 protobuf body，以及 big-endian / little-endian 两个完整 frame），共同校验 magic、codec、reserved、CRC、size、request_id、type 和 body 字节。

## 8. 目录结构建议

当前不建议把仓库根目录立即改成 `docs/`、`frontend/`、`backend/`、`protocol/`、`scripts/` 五段式。这个项目是 Go 主仓库，`cmd/`、`internal/`、`tests/`、`tools/` 符合 Go 生态约定；强行移动到 `backend/` 会影响 import path、脚本、文档链接和部署入口，收益暂时不足。

更稳妥的演进方式：

1. 短期保持现状，只把协议入口文档和 README 索引写清楚。
2. 如果协议需要独立发布，再考虑新增顶层 `protocol/`，把 `.proto`、生成配置和 golden tests 迁出。
3. 如果后端要独立成可发布服务，再整体规划 `backend/`，同时调整 Go module 路径、CI、脚本和部署文档。
4. `tools/` 继续承载真实脚本实现；不建议改名为 `scripts/`，因为当前已有 `tools/scripts/` 与兼容入口。
