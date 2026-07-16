# Yimsg 多许可证说明 / Multi-License Notice

## 中文

Yimsg 是单一公开 monorepo，但不同组件采用不同许可证：

- `server/**` 与 `apps/web/**`：`AGPL-3.0-only`。
- `protocol/**`、`packages/sdk/**`、`packages/uikit/**` 与 `website/**`：`Apache-2.0`。
- UIKit 示例和对应测试随 UIKit 使用 `Apache-2.0`；服务端测试与官方 Web App 测试随对应组件使用 `AGPL-3.0-only`。
- 根目录跨组件文档和纯构建、协议、SDK、UIKit 工具原则上使用 `Apache-2.0`；仅服务于 Server 或官方 Web App 的脚本按 `AGPL-3.0-only`。逐项映射以 `REUSE.toml` 为准。

`Apache-2.0` 不授予 Yimsg 名称、Logo、图标或其它品牌标识的商标使用权，具体见 [TRADEMARKS.md](TRADEMARKS.md)。

版权所有者未来可以为其有权许可的 AGPL 组件另行提供商业许可证。此说明不是商业许可证合同，也不表示任何第三方贡献已经授权用于单独的商业许可。

历史上已经按 Apache-2.0 发布的版本继续受当时许可证约束，本次目录与许可证治理不追溯改变已发布版本。

本文件用于说明仓库许可结构，不构成法律意见。如需判断特定使用、分发、网络部署或商业授权义务，请咨询合格的法律专业人士。

## English

Yimsg remains one public monorepo, with licenses assigned by component:

- `server/**` and `apps/web/**`: `AGPL-3.0-only`.
- `protocol/**`, `packages/sdk/**`, `packages/uikit/**`, and `website/**`: `Apache-2.0`.
- UIKit examples and tests follow UIKit under `Apache-2.0`; server tests and official Web App tests follow their components under `AGPL-3.0-only`.
- Cross-component documentation and general build, protocol, SDK, and UIKit tooling are generally `Apache-2.0`; tools used only by the Server or official Web App are `AGPL-3.0-only`. `REUSE.toml` contains the file-level directory annotations.

The Apache License does not grant rights to use the Yimsg name, logos, icons, or other brand identifiers as trademarks. See [TRADEMARKS.md](TRADEMARKS.md).

Copyright holders may offer separate commercial licenses for AGPL components they are entitled to license. This notice is not a commercial license agreement and does not claim that third-party contributions are available for separate commercial licensing.

Versions previously released under Apache-2.0 remain available under the terms that applied when they were released. This repository change is not retroactive.

This document explains the repository's licensing structure and is not legal advice. Consult qualified counsel for questions about a specific use, distribution, network deployment, or commercial licensing arrangement.
