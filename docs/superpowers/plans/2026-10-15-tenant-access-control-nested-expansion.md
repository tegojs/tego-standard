# 多层关联组装实现计划

沿用已批准设计，在 `feat/tenant-access-control` 执行测试驱动、计划执行、独立复审和签名提交。

## 目标与边界

内部 `listExpanded` / `getExpanded` 的展开项增加可选 `expansions` 子项，最多三层、整棵树共 20 个关联。每层分别检查来源关联字段、目标字段和中间表权限，完整路径授权、关系及配置元数据在第一次异步调用前固定。允许中间层只输出关联，叶子仍须明确物理字段；隐藏父项不查询出其后代并挂回其他记录。

三类批量展开服务提供独立内部配对页 `{ key, values }`，使用已经读取的目标主键拼接，不扩大输出字段权限。现有 `load` 返回契约及 1000 来源上限保留。内部配对页最多接收 10000 个已读取来源键，以承接上一层的目标页；仍执行原有来源、目标和连接权限、事务与 10000 目标/配对上限。主键规范化仅在内存中分段，不按来源行补查 SQL。

整份响应最多展开 100000 个记录位置；共享子树按最终序列化时的实际重复次数计数，不能用内存去重掩盖响应膨胀。超过上限明确拒绝。

不注册业务资源、不改配置或业务数据。现有单层请求、根筛选排序、空值和历史数据语义保留，统一受上述响应数量上限保护。

## 实施与验证

- [x] 在 `packages/module-tenant/src/server/__tests__/access-control/expanded-reads.test.ts` 增加反向测试关联及多层用例：四类关系组合、只输出关联、隐藏中间项、完整路径权限、提前拒绝、元数据变化、请求快照、事务、共享表、宽页、坏输入与 20/100 来源固定查询次数。先运行 `pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/expanded-reads.test.ts -t nested --maxWorkers=1 --pool=threads --no-file-parallelism`，确认因尚不接受子展开失败。
- [x] 新增 `access-control/expansion-page.ts`：配对记录类型、受限输入快照和最多 10000 个键的规范化；在三个 `*-expansion.ts` 中复用同一查询，分别提供 `page` 和原有 `load` 投影，配对信息只供内部组装。
- [x] 修改 `access-control/expanded-reads.ts`：递归验证三层/20 个节点、同步准备全部路径权限与元数据，再按每条路径一次批量查询，按内部键递归组装；已读取目标去重后成为下一层来源，不按行查询。
- [x] SQLite/PostgreSQL 回归组装、根读取和三类展开；严格类型、oxlint、Prettier、`pnpm exec tegod build @tachybase/module-tenant`、独立审查通过；清理并确认随机专用测试库已删除。
- [x] 更新设计进度和本计划验证记录，只暂存本阶段代码、测试与文档，检查暂存差异后签名原子提交。

## 验证记录

- 红灯：三层展开首先因不支持子展开而失败；响应膨胀用例首先返回了超过上限的结果，随后增加总响应保护。
- 2026-10-16：`expanded-reads`、`reads`、`belongs-to-expansion`、`target-foreign-key-expansion`、`many-to-many-expansion` 五个测试文件在 SQLite 和本地 PostgreSQL 共 662 项全部通过，其中组装测试 126 项。随机专用测试数据库已删除，并查询确认不存在。
- 严格 TypeScript 检查无诊断；六个变更 TypeScript 文件 oxlint 无错误或警告；代码和两份文档通过 Prettier 检查；租户模块构建退出码为 0。
- 独立只读审查未发现阻塞问题，核对了完整路径授权、首次异步前快照、隐藏父项、重复子树预算及旧 `load` 契约。额外轻量验证确认内部页接受 10000 个来源键，旧入口仍拒绝超过 1000 个来源键，输入快照与跨段去重有效。
- 本阶段仍是内部读取能力，未注册业务资源、修改业务配置或启用页面；框架参数适配和真实业务试点另行完成。
