# 详情目标键适配计划

沿用已批准的租户访问控制设计，在当前功能分支使用计划执行及测试驱动流程完成内部详情入口，不注册资源或修改业务配置。

## 契约

`getFromParams` 按核心 `collection.filterTargetKey` 的有效值定位记录，支持唯一主键之外的单个物理字符串、文本、UUID 或整数字段。请求仍仅提供 `filterByTk`，不能指定字段、SQL 或授权。服务端先捕获目标字段，再经 selected/expanded/root 读取链传递；根权限及请求筛选始终与目标键条件相交。定位字段可以不在输出字段授权中，不能因此读取、筛选或输出其他隐藏字段。

内部 `AccessGetRequest` 增加 `keyField`，必须等于当前表的有效目标字段；未提供时维持旧的主键语义。独立 `read-key.ts` 校验目标字段并规范化其值，不修改写入、关联配对和普通主键读取的既有键限制。非主键值最多 512 字符，与参数转换上限一致；数字必须是安全整数，整数文本规范化，字符串及 UUID 保留原值，比较语义由数据库决定。日期、JSON、虚拟、关联字段和复合主键明确拒绝。业务目标键不负责关联拼接，展开继续使用真实主键。

根计划在首次 await 前固定字段和值，查询前后及展开后检查目标字段配置和元数据，不能在查询准备期间切换字段。事务、角色条件、G/V、默认范围和软删除沿用已有链。配置为非唯一字段时保留核心 `findOne` 语义，不新增唯一性要求。

## 步骤

- [x] 在 `__tests__/access-control/expanded-reads.test.ts` 替换原来拒绝业务目标键的断言，验证按 amount 定位与真实主键不同的记录，运行确认现有守卫拒绝；补隐藏定位字段、G/V、角色条件、请求条件、关联拼接、输入快照、事务及元数据变化回归。
- [x] 新建 `access-control/read-key.ts` 和 `__tests__/access-control/read-key.test.ts`，先测试字符串/整数/UUID、物理列映射、无效类型与旧主键限制，再实现最小字段和值校验。
- [x] 修改 `access-control/entry-reads.ts` 捕获表目标字段，selected 只在 get 接收内部 `keyField`；`expanded-reads.ts` 传递该参数；`reads.ts` 将目标键谓词加入已有根筛选，并在生命周期检查中复核字段配置。
- [x] 运行目标键单测及双数据库根读取、组装读取和资源参数回归，严格类型、lint、格式和租户包构建；独立审查并修复有效问题。
- [x] 确认独立 PostgreSQL 测试库清理，更新设计及验证结果，纳入同一签名原子提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/read-key.test.ts packages/module-tenant/src/server/__tests__/access-control/resource-read-params.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts packages/module-tenant/src/server/__tests__/access-control/expanded-reads.test.ts --maxWorkers=1 --pool=threads --no-file-parallelism --reporter=dot`。数据库回归使用随机独立本地 PostgreSQL 测试库，不连接业务库。

## 实施与验证

- 红灯已观察：业务目标字段请求被原有主键专用守卫拒绝；大写业务 UUID 在 SQLite 原样持久化后，核心 Repository 能找到记录，但强制小写的定位值查不到。补齐目标键适配、保留非主键 UUID 原值后，对应断言通过。
- 最终 5 个文件、485 项全部通过，退出码 0：目标键 32、资源参数 59、字段选择 44，SQLite/PostgreSQL 根读取各 61、组装读取各 114。目标键单测包含真实 SQLite 持久化与核心 Repository 对照；双数据库入口覆盖隐藏定位字段、权限交集、映射列、恶意文本、关联配对、默认范围/软删除、事务和查询中配置及元数据变化。
- UUID 自审补充发生在第一次回归期间，已终止该次测试子进程并确认独立库清理；修正后重新完整运行，以上统计仅采用最终结果。最终随机 PostgreSQL 测试库也已删除，并查询系统目录确认不存在；未接触业务库。
- 独立审查及 UUID 修正复审均未发现阻塞问题。严格 TypeScript（含测试）0 诊断，6 个 TypeScript 变更文件 oxlint 0 错误/警告，Prettier 检查及租户包构建通过。
- 核心仓库只读核实协议；没有依赖、业务数据、生产配置或资源注册变动。生成产物、本地运行器和日志不提交。
