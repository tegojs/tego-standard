# 外部数据源部门角色解析设计

## 背景

某用户没有通过 `rolesUsers` 关联直接获得角色，而是仅通过部门关联获得角色。切换为该部门角色后访问使用外部数据源的管理页面，页面调用列表 API 时返回：

```json
{
  "errors": [
    {
      "message": "当前用户没有角色，请使用其他账号。",
      "code": "USER_HAS_NO_ROLES_ERR"
    }
  ]
}
```

这属于代码性错误，不是业务数据错误。当前数据满足系统既有的部门角色模型，但外部数据源没有执行部门角色解析逻辑。

## 根因

主数据源的请求链包含以下中间件：

```text
auth
  -> setDepartmentsInfo
  -> setCurrentRole
  -> acl
```

`setDepartmentsInfo` 从主数据库加载当前用户的部门及部门角色，并把部门角色写入 `ctx.state.attachRoles`。
`setCurrentRole` 再把直接角色与 `attachRoles` 合并。

外部数据源拥有独立的 `resourceManager`，请求链只有：

```text
auth
  -> setCurrentRole
  -> acl
```

因此，仅有部门角色的用户进入 `setCurrentRole` 时，直接角色和附加角色都为空，最终抛出 `USER_HAS_NO_ROLES_ERR`。

## 目标

- 在所有数据源调用 `setCurrentRole` 时，先执行统一的异步角色扩展点。
- 让部门插件通过扩展点补充部门角色，使仅有部门角色的用户可以访问已授权的外部数据源。
- 保留主数据源现有中间件标签和顺序，避免影响依赖 `setDepartmentsInfo` 排序的子账号插件。
- 保持直接角色、默认角色、匿名角色、角色缓存及无角色错误的既有行为。

## 非目标

- 不改变部门、用户或角色的数据模型。
- 不改变 ACL 授权策略，也不自动授予外部数据源权限。
- 不处理子账号角色在外部数据源上的扩展问题。
- 不把部门中间件硬编码到数据源管理模块。

## 方案

### ACL 扩展点

`setCurrentRole` 在确认存在登录用户后、读取 `ctx.state.attachRoles` 前，执行：

```typescript
await ctx.tego.emitAsync('acl:beforeSetCurrentRole', ctx);
```

扩展点使用应用现有的 `AsyncEmitter`。监听器按注册顺序串行执行，`setCurrentRole` 会等待所有监听器完成后再合并角色。

匿名请求保持现有短路逻辑，不触发登录用户的角色扩展。

### 部门角色加载

部门插件把现有 `setDepartmentsInfo` 拆成两个职责：

- `loadDepartmentsInfo(ctx)`：加载部门信息和部门角色，不负责中间件续传。
- `setDepartmentsInfo(ctx, next)`：调用加载函数，再调用 `next()`，继续作为主数据源中间件使用。

部门插件同时为 `acl:beforeSetCurrentRole` 注册 `loadDepartmentsInfo`。
这样主数据源继续使用原有中间件位置，外部数据源则通过 ACL 扩展点执行同一套加载逻辑。

### 请求级幂等

主数据源会先执行 `setDepartmentsInfo`，之后 `setCurrentRole` 仍会触发扩展点。
为避免同一请求重复查询，`loadDepartmentsInfo` 使用模块内部 `Symbol` 在 `ctx.state` 上记录已执行状态。

标记只在单个请求上下文内生效，不改变跨请求缓存规则。现有 `departments:<userId>` 缓存及失效事件保持不变。

## 请求流程

修复后的外部数据源请求链如下：

```text
auth
  -> setCurrentRole
    -> emitAsync('acl:beforeSetCurrentRole', ctx)
      -> department.loadDepartmentsInfo(ctx)
    -> merge direct roles and department roles
    -> resolve X-Role or default role
  -> acl
```

主数据源请求链保持如下顺序：

```text
auth
  -> setDepartmentsInfo
  -> optional middlewares ordered after setDepartmentsInfo
  -> setCurrentRole
    -> department hook (request marker makes it a no-op)
  -> acl
```

## 错误行为

- 用户既没有直接角色，也没有任何扩展角色时，继续返回 HTTP 401 和 `USER_HAS_NO_ROLES_ERR`。
- `X-Role` 不在合并后的角色集合中时，继续返回 HTTP 401 和 `ROLE_NOT_FOUND_ERR`。
- 部门查询或角色查询失败时，不吞掉异常，由现有错误处理中间件处理。
- 部门角色只参与当前角色选择，不绕过外部数据源 ACL 授权。

## 测试策略

### 红灯回归测试

在真实测试应用中同时启用 ACL、用户、部门和数据源插件，创建：

- 一个没有直接角色的用户；
- 一个部门；
- 一个通过该部门授予用户的角色；
- 一个已为该角色配置查看权限的模拟外部数据源。

用户携带对应 `X-Role` 请求外部数据源列表接口。修复前应稳定返回 HTTP 401 和 `USER_HAS_NO_ROLES_ERR`；期望行为为 HTTP 200。

### 行为不变量

回归测试至少覆盖：

- 指定直接角色；
- 直接角色的默认选择；
- 匿名角色；
- 真正无角色用户；
- 主数据源部门角色；
- 外部数据源部门角色；
- 外部数据源仍按角色策略授权。

## 变更范围

- `packages/module-acl/src/server/middlewares/setCurrentRole.ts`
- `packages/plugin-department/src/server/middlewares/set-departments-roles.ts`
- `packages/plugin-department/src/server/plugin.ts`
- `packages/module-data-source/src/server/__tests__/data-source-with-acl.test.ts`

不修改业务数据、数据库迁移、客户端角色切换逻辑或外部数据源中间件注册方式。
