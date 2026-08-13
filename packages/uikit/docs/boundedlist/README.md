# BoundedList 文档索引

> 主要对照：`packages/uikit/src/app/bounded-list/`、`packages/uikit/src/app/views/`、`packages/uikit/tests/unit/bounded-list/` 与 `apps/web/tests/{component,performance,support}/bounded-list*`。
> 最后复核：2026-08-13。
> 触发更新：BoundedList 文档增删改名、生产接入范围、测试入口或缺陷状态变化时同步更新。
> 入口关系：上级前端索引见 [`../../../../docs/architecture/前端文档索引.md`](../../../../docs/architecture/前端文档索引.md)；本目录集中维护 BoundedList 当前事实，不保存已删除实现的迁移过程。

## 阅读顺序

| 目标 | 文档 |
|---|---|
| **第一次读源码 / 想弄清整体设计** | [`导读.md`](导读.md) |
| 查参数、状态、方法与行为规则的准确口径 | [`组件设计.md`](组件设计.md) |
| 把生产列表接入组件或修改宿主路由 | [`生产集成.md`](生产集成.md) |
| 修改测试、覆盖矩阵或性能门禁 | [`测试方案.md`](测试方案.md) |
| 查询当前缺陷状态或登记新缺陷 | [`缺陷列表.md`](缺陷列表.md) |
| 查询已关闭缺陷的复现条件、根因与关闭证据 | [`../../../../docs/archive/BoundedList缺陷列表.md`](../../../../docs/archive/BoundedList缺陷列表.md) |

## 单一事实源

- `导读.md` 讲「为什么这样分层、按什么顺序读」，不重复参数表。
- `组件设计.md` 是接口与行为的单一事实源，只描述当前 `bounded-list/` 实现。
- `生产集成.md` 只描述调用方接线、生命周期和仍未接入的场景，不复制组件类型表。
- `测试方案.md` 维护三层测试的分工、用例分类、覆盖率与执行入口。
- `缺陷列表.md` 保留缺陷编号、状态与登记规则；运行结果必须以当次命令输出为准。已关闭缺陷的复现条件、修复和回归证据归档在 `../../../../docs/archive/BoundedList缺陷列表.md`。
