# 租户访问模型：一对一替换与解绑

沿用已批准的 G/V 设计，在 `feat/tenant-access-control` 实现内部 HasOne 适配。使用 writing-plans、test-driven-development、requesting-code-review 和 verification-before-completion；验证后单独提交，不启用业务入口、不升级依赖、不修改业务数据库或线上。

## 接口和约束

`AccessHasOneService.withTarget(ctx, source, target, authenticated, request)` 接受：

```ts
{
  association: string;
  sourceKey: string | number;
  targetKey: string | number | null;
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  targetReadWhere?: WhereOptions;
  targetReadBind?: Record<string, unknown>;
}
```

返回实际修改目标的 `{ keys, affected }`。`targetKey: null` 表示解绑；不能省略目标，不接受数组、嵌套写入、目标删除或外部事务。来源须满足 G；明确的新目标须满足读取权限；旧目标解绑和新目标绑定均须满足修改前 G 及目标更新 ACL。无变化的已读目标不需要更新权限，也不认领历史归属。

只支持同库、不同模型、单主键、普通无 scope 的 HasOne。若来源实际上已有多条目标记录，拒绝修改，不擅自清理数据。来源和全部候选目标先锁定，再完整授权；写入顺序为先解绑再绑定，以支持目标外键的唯一约束。改换目标的来源不发生归属迁移；历史来源及实际编辑的历史目标按已有规则认领。冲突返回 409，回滚不触发提交通知。

## 文件和步骤

- [x] 新增 `__tests__/access-control/has-one.test.ts`，使用独立测试库，先验证服务缺失的红灯。
- [x] 将 `has-many.ts` 的事务写入流程移至 `target-foreign-key.ts`，原 `AccessHasManyService` 保持接口和行为；新增 `has-one.ts` 的单目标入口，关系类型仅由服务端类固定。
- [x] 将 `has-many-metadata.ts` 改为 `target-foreign-key-metadata.ts`，复用同库身份及外键检查，只允许对应的真实 HasMany/HasOne 类型及兼容反向关联。
- [x] 验证新绑定、替换、解绑、跨来源改挂、无变化、来源或任一实际目标仅 V、角色读取及更新条件、隐藏旧目标、缺失目标、默认 scope、历史认领和回滚。
- [x] 验证唯一外键、不可为空外键、多旧目标、错误关系类型、未知字段、元数据替换、Hook 额外写入、失败回滚不通知。错误外键或归属的公共保护也保留在 HasMany 回归中验证。
- [x] 用真实 PostgreSQL 验证同一来源并发换目标、同一目标被不同来源绑定和撤权冲突。运行 HasOne/HasMany 聚焦测试、联合回归、严格类型检查、lint、格式及租户模块构建。
- [x] 独立审查未发现具体问题，更新本计划和规格；本阶段单独原子提交。

测试沿用严格命名的独立本地 PostgreSQL 库，结束精确删除；SQLite 仅验证不支持关系写入。业务中间表、配置界面及各业务入口仍在后续阶段。

## 验证结果

- 红灯已确认：先验证模块缺失，再以未实现服务验证真实行为失败。
- HasOne 42 项、HasMany 46 项，共 2 个文件、88 项聚焦测试通过，无跳过。
- 新访问控制服务、原租户过滤与历史认领、ACL 来源的联合回归：19 个文件、593 项测试全部通过，无跳过。
- 严格 TypeScript 检查通过；5 个变更代码及测试文件的 oxlint 无警告、无错误，Prettier 检查通过。
- `pnpm exec tegod build @tachybase/module-tenant` 构建成功。
- 独立审查覆盖共享流程迁移、一对一基数、读取和更新条件、历史认领、Hook 防护、唯一外键顺序与并发，未发现具体问题。

验证仅使用独立测试库，没有修改本地业务数据或线上。该阶段仍是内部能力，尚未接入业务请求；不代表业务入口、配置界面和真实业务性能已经验收。
