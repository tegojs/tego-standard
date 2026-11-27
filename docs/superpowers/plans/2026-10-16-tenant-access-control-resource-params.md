# 页面读取参数转换计划

沿用已批准的访问控制设计，继续在功能分支内实现和验证，不注册业务资源或修改业务配置。使用 writing-plans、executing-plans 和测试驱动流程。

## 本阶段契约

新增内部 `listFromParams/getFromParams`：接收框架已解析的 action params，分页列表将 `page/pageSize` 转成 `offset/limit`，详情将 `filterByTk` 转成 `key`；字段、关联、排除、筛选和排序继续交给已有读取链。返回值仍是记录数组或单条/null，不声称已适配完整 HTTP 分页响应及计数。

详情仅支持核心 `collection.filterTargetKey` 等于唯一主键的模型，查询前后检查该契约；业务目标键和复合主键明确拒绝，不把业务键错误转换为另一个主键值。

默认页码 1、每页 20，与主库核心 action 一致；只接受正安全整数及规范十进制字符串，最多每页 1000、偏移 1000000。拒绝无法精确计算的偏移、0、负数、浮点、空白、科学计数法、部分数字。仅支持分页的平面列表，拒绝 `paginate=false`、树查询以及未知参数；不能用截断列表冒充完整未分页结果。`sort` 可为数组或逗号分隔字符串，数组先按原型、密度和描述符校验后复制，不提前归一化坏输入。根参数拒绝访问器和未知键，保留非枚举数据属性；事务由服务端单独参数提供，不允许 action params 提供事务、授权或 SQL。

## 步骤与文件

- [x] 新建 `__tests__/access-control/resource-read-params.test.ts`，先验证默认分页、数字字符串、详情映射、描述符与数组拒绝、输入快照和上限；观察缺少解析器及默认分页断言失败。
- [x] 新建 `access-control/resource-read-params.ts`：纯同步参数转换，返回已有 `AccessSelectedListRequest/AccessSelectedGetRequest`，不执行 SQL、不判断权限。
- [x] 修改 `access-control/entry-reads.ts`，增加两个内部方法，单独接受可信事务；在 `expanded-reads.test.ts` 验证实际分页/详情/关联/权限/快照/事务，先观察入口缺失失败。
- [x] 运行新参数单测、字段选择回归及双数据库组装读取回归，严格类型、lint、格式、租户包构建；独立审查，确认测试库清理，更新设计并签名提交。

聚焦命令：`pnpm exec vitest run packages/module-tenant/src/server/__tests__/access-control/resource-read-params.test.ts packages/module-tenant/src/server/__tests__/access-control/read-selection.test.ts packages/module-tenant/src/server/__tests__/access-control/expanded-reads.test.ts --maxWorkers=1 --pool=threads --no-file-parallelism --reporter=dot`。PostgreSQL 使用已有本地独立测试库运行器；不连接业务库。

## 实施与验证

- 红灯已观察：默认分页占位实现返回空对象；缺少 `listFromParams`；业务目标键被错误当成主键后返回记录；查询期间目标键变化仍返回结果。对应实现和守卫补齐后断言通过。
- 最终聚焦回归 3 个文件、283 项全部通过，退出码 0：参数单测 59 项、字段选择回归 44 项，SQLite/PostgreSQL 组装读取各 90 项（每库新增 9 项入口用例）。独立 PostgreSQL 测试库已删除，并查询系统目录确认不存在；未接触业务数据。
- 独立审查发现核心目标键和主键并不总是一致，已采用本阶段明确拒绝不支持模型的方式修复并补回归；复审未发现阻塞问题。
- 严格 TypeScript（含测试）0 诊断；4 个变更 TypeScript 文件 oxlint 0 错误/警告、Prettier 通过，租户包构建成功。暂存时排除生成产物及本地运行器。
