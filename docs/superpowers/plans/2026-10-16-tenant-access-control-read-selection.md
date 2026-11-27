# 框架读取字段选择转换计划

沿用已批准的租户访问控制设计，在现有功能分支按测试驱动、独立审查、签名原子提交推进。本阶段只增加内部转换入口，不注册业务资源。

## 目标与契约

将框架 `fields`、`appends`、`except` 转为新读取服务的明确物理字段和最多三层、20 个关联的展开树。全部路径按真实登记关联解析；每个来源关联字段、目标操作及输出字段仍需分别授权，多对多连接权限继续由展开服务检查。省略字段表示当前路径已授权的物理字段，不自动展开其他关联，不加入隐藏配对主键或虚拟 getter。

依据核心 `OptionsParser.parseFields/parseAppends/parseExcept`：根 `fields` 是显式选择，关联路径也可写在 `fields` 中；裸关联优先于同一路径的具体字段；仅由深层路径产生的中间层默认取普通字段，除非同层已有明确字段；`except` 只作用于默认字段，不覆盖显式字段选择，且不创建额外关联。重复路径合并，不重复查询。与真实核心 Repository 的查询选项对照验证这些支持的规则。

仅接受数组形式、登记物理字段和普通点路径。带括号的关联选项、通配符、虚拟字段、跨库关联、未知字段、超过三层/20 个节点、坏描述符及访问器明确拒绝；不默默转用旧读取。`except` 只支持物理字段路径，不实现核心对裸关联排除的模糊行为。明确选择的未授权字段拒绝，默认字段只取授权交集。

内部 `listSelected/getSelected` 仍接收现有内部的 `limit/offset/key/filter/sort/transaction`，不是完整资源 API 参数适配器。请求原始描述符先校验，字段选择同步快照；筛选排序保持原始输入交给已有校验。一次操作的路径 grant 缓存供字段转换、筛选、排序和展开共同使用，全部授权与元数据检查保留，禁止跨请求缓存。

## 文件与步骤

- [x] 新建 `packages/module-tenant/src/server/__tests__/access-control/read-selection.test.ts`，使用真实模型及核心 Repository 选项构造，对照默认、显式、裸关联、嵌套和排除行为；覆盖路径授权、大小限制、坏输入及快照。先运行该文件，确认缺少转换器而失败。
- [x] 新建 `packages/module-tenant/src/server/access-control/read-selection.ts`，同步解析受限字段参数为 `{ attributes, expansions }`，不执行 SQL。
- [x] 修改 `access-control/entry-reads.ts`，增加 `listSelected/getSelected`，共享本次操作的路径授权，再调用已有根读取或多层组装服务。在 `expanded-reads.test.ts` 增加实际双数据库用例：四类关联、隐藏目标、角色范围、事务、查询期间权限变化及固定查询次数。
- [x] 运行聚焦单测、SQLite/PostgreSQL 读取回归，严格类型、oxlint、Prettier 和租户包构建；完成独立审查并清理专用测试库。
- [x] 更新设计进度和验证记录，检查变更范围后签名原子提交。

## 验证记录

- 红灯：缺少转换器；最小占位实现未返回授权默认字段；入口尚无 `getSelected`；权限回调替换根筛选后错误返回另一条记录。实现后对应断言转绿。
- 单测：44 项字段选择测试，包括 14 组与真实核心 Repository 投影选项的对照。入口新增 18 项测试，覆盖四类关联、嵌套输出、授权缓存、严格输入、事务、阶段变化、共享表、并发身份及 20/100 条来源的相同查询次数。
- 静态检查：严格 TypeScript（含测试、`strict`、`noUnusedLocals`）0 诊断；4 个变更 TypeScript 文件 oxlint 0 错误/警告，Prettier 通过；`pnpm exec tegod build @tachybase/module-tenant` 成功。
- 独立只读审查未发现阻塞问题；最后的根参数描述符捕获修复另经复核。审查额外进行了 2874 组核心投影对照，未发现差异；核心自身抛错的组合未当作兼容承诺。
- SQLite/PostgreSQL 读取回归：6 个文件、742 项测试全部通过（含 44 项元数据选择单测及两种数据库的 698 项实际读取测试），退出码 0。独立 PostgreSQL 测试库已删除，并查询系统目录确认不存在；未接触业务数据。
