# 多值关联展开的入口权限接入

沿用已批准设计，在 `feat/tenant-access-control` 完成 HasMany、HasOne 和 BelongsToMany 的内部入口接入；不启用业务接口、不改业务数据或依赖。

## 设计与文件

- `access-control/entry-reads.ts`：复用单值展开的输入验证、来源及目标授权；增加 `expandTargetForeignKey` 与 `expandManyToMany`。多对多中间表通过已登记的 through 模型取得，沿用筛选解析器的 `[关联名, '$through']` 授权路径，独立检查操作和行范围，不要求输出中间字段。
- `access-control/target-foreign-key-expansion.ts` 与 `many-to-many-expansion.ts`：增加内部可选授权生命周期检查，覆盖首个 await 前及各次查询后；已授权 JSON 输出不套写入输入限制。
- 两份对应展开测试：分别验证来源、目标及中间表的 G/V 与最终角色权限、字段限制、隐藏关联、授权事实、请求快照、事务和固定查询次数。
- 更新设计进度和本计划验证记录。

## 步骤

- [x] 添加真实数据库失败用例，确认缺少入口能力。
- [x] 实现公共展开准备与两类入口。权限在首个 await 前固定，不接受请求方 SQL、过滤条件或模型身份；旧 BelongsTo 契约保持兼容。
- [x] 验证隐藏来源整体拒绝，隐藏目标或连接返回空，HasOne 基数及现有上限保留；元数据变化后拒绝返回，历史读取不认领。
- [x] SQLite/PostgreSQL 运行三类展开和统一根读取回归；严格类型、格式、lint 与租户包构建通过；清理专用测试库。
- [x] 独立代码审查无实质问题，更新文档；本阶段以原子化签名提交保存。

多对多不返回中间记录，不因连接键或内部授权事实而扩大字段权限。目标 JSON 仍仅按明确物理字段投影。输入最多 1000 个来源，实际目标或来源/目标配对最多 10000；不引入嵌套展开、每来源分页排序或业务配置。

回归命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/belongs-to-expansion.test.ts packages/module-tenant/src/server/__tests__/access-control/target-foreign-key-expansion.test.ts packages/module-tenant/src/server/__tests__/access-control/many-to-many-expansion.test.ts packages/module-tenant/src/server/__tests__/access-control/reads.test.ts --reporter=dot --maxWorkers=1 --pool=threads --no-file-parallelism`。PostgreSQL 使用随机专用本地测试库，结束后删除并确认，不对业务库执行建表或清理。

先运行两个入口成功场景，均因方法不存在失败；实现后 33 个入口用例通过，另两个大 JSON 用例实际复现 `Mutation input exceeds size or depth limit`。修正输出投影后，35 个入口用例全部通过，再补事务、共享表、历史与并发交叉验证。输入校验未放宽，旧接口的类型缺口只作类型修正，不改变测试行为。

## 验证结果

- SQLite/PostgreSQL 四文件 536 项全部通过（单值展开 146、一对多/一对一展开 108、多对多展开 160、根读取 122），退出码 0；随机专用 PostgreSQL 测试库已删除并确认。
- 严格 TypeScript 0 个诊断；五个变更代码/测试文件的 oxlint 0 个警告或错误，Prettier 检查通过；`pnpm exec tegod build @tachybase/module-tenant` 成功。
- 独立审查未发现实质问题，确认三表独立授权、权限快照和生命周期检查、物理列与配对键边界、批量查询，以及 BelongsTo/根读取兼容。
- 未注册业务资源、启用业务规则或修改业务数据。嵌套展开组装、真实入口适配与实际业务性能验收继续按已批准设计分阶段进行。
