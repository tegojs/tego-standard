# 租户访问规则配置保存与读取

**目标：** 规则从主数据库读取，保存时避免相互覆盖并留下版本记录。本阶段不接入业务请求，不启用任何业务表。

**执行：** 在 `feat/tenant-access-control` 内联执行，先测试后实现。使用现有 Repository 和模型钩子；不改依赖、核心代码和线上数据。提交等待用户明确要求。

## 1. 配置存储

文件：`access-control/config-store.ts`、`access-control/config-history.ts`、`__tests__/access-control/config-store.test.ts`。

- [x] 先编写缺失配置、非法配置、同名不同数据源、表删除重建、主库读取和请求快照测试，运行确认失败。
- [x] 实现 `AccessConfigStore.read(identity)`，按 `dataSourceKey`、持久化 `collectionKey`、表名核对目标；显式非法值抛错，缺失值返回 `null`，不自行启用旧规则。
- [x] 实现 `AccessConfigStore.save(identity, config, actor)`，输入 `revision` 表示编辑基准。事务锁定元数据行，检查基准版本，验证规则，合并最新 `options`，通过 Repository 保存。
- [x] 保存成功的版本递增，并在同一事务记录前后配置、操作者、时间；失败不写配置或历史。恢复旧规则内容通过重新保存产生新版本，不删除审计记录。
- [x] 验证空规则合法但不授权、旧版本冲突、其他选项不丢失、钩子失败回滚、快照不可修改、不同请求看到最新配置。

调用约定：

```typescript
const identity = { dataSourceKey: 'main', collectionKey: 'persisted-key', collectionName: 'documents' };
const config = await store.read(identity);
await store.save(identity, { ...editedConfig, revision: config?.revision ?? 0 }, { userId: authenticatedUserId });
```

元数据解析函数只由服务端注入，返回的稳定键必须与数据源及持久化表键一致。内部方法不代替管理员认证，不能直接暴露成 HTTP 操作。

## 2. 所有配置修改路径的约束

- [x] 核实普通表编辑的 MagicAttributeModel 选项合并协议。
- [x] 增加显式注册、默认未启用的元数据修改保护：普通更新不带新规则时保留已有规则；尝试直接改规则要求走统一存储服务。
- [x] 验证主数据源、外部数据源、普通 Repository 更新和批量更新；不依靠请求参数中的特殊标记授权。
- [x] 明确能力边界：本轮只验证默认 Hook 协议，未接入应用配置接口及启动流程，禁止据此启用新模型。

## 3. PostgreSQL 并发与检查

文件：`__tests__/access-control/config-store-postgres.test.ts`；共享独立本地测试连接构造器。

- [x] 两个数据库实例同时用同一版本保存，只能一个成功，另一个得到版本冲突；不能覆盖无关选项。
- [x] 两个独立实例的新读取看到已提交新版本，旧请求快照维持原版本；事务失败不留下历史。
- [x] 运行 access-control 全部测试、现有租户过滤和历史认领回归、oxlint、Prettier、严格类型检查及租户模块构建。
- [x] 删除本轮创建的独立测试库，记录实际通过数量与尚未接入的入口。

## 4. ACL 来源核查

- [x] 找出角色配置中的 scope 对象在哪里转换为 ACL filter，再在哪里与请求条件合并。
- [x] 记录适配位置；本阶段不删除、替换已有 ACL 条件，不修改现有权限行为。

## 已核实的 ACL 接入位置

`module-acl/src/server/model/RoleResourceActionModel.ts` 的 `writeToACL` 从 `getScope()` 取得持久化范围，将 `scope.scope` 放入 `actionParams.filter` 后调用 `role.grantAction`。外部数据源的 `DataSourcesRolesResourcesActionModel` 继承同一实现。到这一步后，现有 action 参数已经不保留范围记录的来源。

核心 `packages/acl/src/acl.ts` 的 `can()` 还会合并固定条件；`addCoreMiddleware()` 随后解析变量并调用 `resourcerAction.mergeParams`，将权限条件与请求筛选合并。因此后续应从 `writeToACL` 保留服务端确认的来源信息，再在合并之前处理委托，不能事后删除 `tenantId` 条件。本轮只核查，没有修改这些代码。

## 验证结果及接入边界

10 个测试文件、192 项测试全部通过，无跳过。其中本轮配置读取保存 20 项、普通修改保护 18 项、PostgreSQL 独立实例并发 5 项；之前的规则编译、模型、身份、查询及租户回归共 149 项继续通过。

规则存储通过主库读取，版本锁定、保存、保存后核对和审计处于同一事务。规则在进入 Repository 前保留不可变校验基准，其他 Hook 无论替换或原地修改规则，都不能使保存基准一起被改写。现有 Hook 或审计失败会整体回滚。

保护通过 `registerAccessConfigGuards` 显式登记。内部临时授权绑定数据库事务对象，不使用请求可伪造的标记。一般元数据更新锁定行并保留最新规则；旧编辑对象也不能覆盖新规则。批量更新需逐行 Hook，跳过逐行校验的选项替换、配置复制及 upsert 明确拒绝。部分 Sequelize 批量 Hook 无法由 Database 正确识别模型，使用模型本身的 Hook 登记，已有对应测试。

审计版本记录加入必需备份集合，默认 Hook 下只由服务创建，普通修改和删除被拒绝。规则管理页面、管理员鉴权和翻译、版本恢复按钮、插件启动注册及真实应用配置接口仍未接入。故意使用 `hooks: false` 或直接 SQL 的服务端代码不受这些 Hook 保护，接入时必须核查并改用统一存储服务，不能宣称已覆盖任意服务器代码。

当前主库与外部数据源的配置记录均从主库读取，但尚未实现跨数据库业务写事务的授权协调。请求快照仅供同一请求或执行阶段复用，写入授权不能沿用旧阶段快照。旧规则机制与新模型的显式切换仍由逐表迁移接口完成，当前没有任何业务表迁移或启用。

21 个 TypeScript 文件的 oxlint 无警告无错误，10 个实现文件的严格类型检查及租户模块构建通过。实际业务数据库与线上环境未写入。
