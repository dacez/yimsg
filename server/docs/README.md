# 服务端文档索引

> 主要对照：`server/cmd/yimsg-server/`、`server/internal/`、`server/tests/e2e/` 与 `server/docs/` 实际文件树。
> 最后复核：2026-07-16。
> 触发更新：服务端文档增删改名、专题分组或关键代码目录变化时同步更新。
> 入口关系：上级索引见 [`../README.md`](../README.md)；本文只负责服务端文档的二级导航和专题归类。

## 目录

- [1. 阅读顺序](#1-阅读顺序)
- [2. 文档分组](#2-文档分组)
  - [2.1 架构与协议](#21-架构与协议)
  - [2.2 数据库与 DAL](#22-数据库与-dal)
  - [2.3 业务专题](#23-业务专题)
- [3. 维护约定](#3-维护约定)

## 1. 阅读顺序

| 目标 | 推荐阅读 |
|---|---|
| 理解服务端整体实现 | [`服务器架构方案.md`](服务器架构方案.md) → [`protocol/docs/接口总览.md`](../../protocol/docs/接口总览.md) → [`推送事件方案.md`](推送事件方案.md) |
| 修改 WebSocket action | [`protocol/docs/接口总览.md`](../../protocol/docs/接口总览.md) → [`服务器架构方案.md`](服务器架构方案.md) → 对应业务专题 |
| 修改表结构说明 | [`db/数据库设计总览.md`](db/数据库设计总览.md) → [`db/schema字段对照.md`](db/schema字段对照.md) → 对应领域数据库文档 → [`protocol/docs/接口总览.md`](../../protocol/docs/接口总览.md) |
| 修改消息链路 | [`docs/architecture/同步机制方案.md`](../../docs/architecture/同步机制方案.md) → [`db/消息数据库设计.md`](db/消息数据库设计.md) → [`消息能力方案.md`](消息能力方案.md) → [`推送事件方案.md`](推送事件方案.md) |
| 修改关系、偏好或红点 | [`docs/architecture/同步机制方案.md`](../../docs/architecture/同步机制方案.md) → [`db/通讯录数据库设计.md`](db/通讯录数据库设计.md) → [`关系与会话偏好方案.md`](关系与会话偏好方案.md) |

## 2. 文档分组

### 2.1 架构与协议

| 文档 | 说明 | 主要代码依据 |
|---|---|---|
| [`服务器架构方案.md`](服务器架构方案.md) | 服务端模块、启动流程、WebSocket dispatch、PostAction、GC | `server/cmd/yimsg-server/main.go`、`server/internal/ws/`、`server/internal/service/` |
| [`protocol/docs/README.md`](../../protocol/docs/README.md) | 协议单一事实源、轻量代码生成和契约一致性治理 | `protocol/` 与 `protocol/generated/go/pb/`、`server/internal/ws/connection.go`、`packages/sdk/src/generated/` |
| [`protocol/docs/接口总览.md`](../../protocol/docs/接口总览.md) | WebSocket action、HTTP 上传 / 静态资源、SDK↔服务端接口映射、`client_config` | `server/internal/ws/connection.go`、`protocol/` 与 `protocol/generated/go/pb/`、`server/cmd/yimsg-server/main.go` |
| [`docs/architecture/同步机制方案.md`](../../docs/architecture/同步机制方案.md) | 消息、通讯录、屏蔽列表、免打扰、会话的通用同步契约 | `server/internal/ws/connection.go`、`server/internal/service/`、`packages/sdk/src/datagateway/` |
| [`推送事件方案.md`](推送事件方案.md) | Notification 类型、触发矩阵、客户端同步策略 | `server/internal/appmsg/notification.go`、`server/internal/service/` |
| [`多媒体资源方案.md`](多媒体资源方案.md) | HTTP 上传、静态资源访问、消息类型扩展 | `server/cmd/yimsg-server/main.go`、`server/internal/service/upload.go` |

### 2.2 数据库与 DAL

| 文档 | 说明 | 主要代码依据 |
|---|---|---|
| [`db/数据库设计总览.md`](db/数据库设计总览.md) | 分片组、表清单、全局约束、GC 总览 | `server/internal/dal/schema.go`、`server/internal/service/gc.go` |
| [`db/schema字段对照.md`](db/schema字段对照.md) | 全部表字段、主键、索引与用途对照 | `server/internal/dal/schema.go` |
| [`db/用户数据库设计.md`](db/用户数据库设计.md) | `user_lookup`、`user_info` 与注册 / 登录相关约束 | `server/internal/dal/user*_store.go`、`server/internal/service/auth.go` |
| [`db/登录态数据库设计.md`](db/登录态数据库设计.md) | `session`、`user_session` 与踢下线 / GC | `server/internal/dal/session_store.go`、`server/internal/dal/user_session_store.go` |
| [`db/通讯录数据库设计.md`](db/通讯录数据库设计.md) | 联系人、收藏群、增量同步、排序缓存名 | `server/internal/dal/contact_store.go`、`server/internal/service/contact.go` |
| [`db/消息数据库设计.md`](db/消息数据库设计.md) | 消息收件箱、会话物化视图、消息 / 会话 GC | `server/internal/dal/message_store.go`、`server/internal/dal/conversation_store.go` |
| [`db/群数据库设计.md`](db/群数据库设计.md) | 群属性、成员关系、成员分页读取 | `server/internal/dal/group_store.go`、`server/internal/service/group.go` |

### 2.3 业务专题

| 分组 | 文档 | 当前边界 |
|---|---|---|
| 关系与会话偏好 | [`关系与会话偏好方案.md`](关系与会话偏好方案.md) | 屏蔽、解除、会话免打扰、未读统计、导航红点 |
| 消息能力 | [`消息能力方案.md`](消息能力方案.md) | 撤回事件、Markdown、引用、转发、@ 提及 |
| 资源能力 | [`多媒体资源方案.md`](多媒体资源方案.md) | 上传入口、媒体访问、消息内容引用 |
| 组织架构 | [`组织架构方案.md`](组织架构方案.md) | org 分片、组织即根 tag（tag 含人也含 tag）、一人多岗按边排序、成员资格并入 contacts、tag 图 seq 同步域 + org:updated 扇出 |
| 插件系统 | [`插件架构方案.md`](插件架构方案.md) | 后端插件接口、宿主能力、协议扩展机制、通用扩展模板 |

## 3. 维护约定

1. `protocol/docs/接口总览.md` 负责列出完整服务端 action、HTTP 接口和 SDK 映射；专题文档只解释业务语义，不重复维护完整接口矩阵。
2. `db/schema字段对照.md` 只转录当前 schema 字段、主键和索引；领域文档负责解释这些字段的业务含义和读写流程。
3. `docs/architecture/同步机制方案.md` 负责跨消息、通讯录、屏蔽列表、免打扰和会话的同步共同规则；领域文档只保留字段、排序、业务行为和 GC 差异。
4. 新增服务端专题前先判断能否合并进现有“架构 / 接口 / 数据库 / 关系与会话偏好 / 消息能力 / 资源能力”分组，避免再次产生阶段性孤立文档。
5. 修改 `server/internal/appmsg/notification.go`、`server/internal/ws/connection.go`、`server/internal/dal/schema.go` 或 `server/internal/dal/*_store.go` 时，优先同步本文链接到的权威文档。
