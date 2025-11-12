# 数据库清理插件需求与实现文档

## 1. 需求概述

`plugin-database-clean` 是一个用于查看数据表占用和清理数据表的插件。该插件允许管理员查看白名单数据表的占用情况，并对符合筛选条件的数据进行备份和清理操作。

### 1.1 核心功能

- 查看白名单数据表的占用大小、数据条数、创建时间、更新时间
- 查看单个数据表的详细数据（支持分页）
- 按时间条件筛选数据（支持 createdAt 和 updatedAt）
- 对筛选后的数据进行备份（可选下载）
- 对筛选后的数据进行物理删除清理

### 1.2 技术约束

- **数据库支持**：目前仅支持 PostgreSQL，其他数据库保留扩展接口暂不做功能
- **白名单机制**：只允许分析和清理白名单表中的数据
- **备份方式**：复用 `module-backup` 的备份逻辑和格式
- **清理方式**：使用通用的 repository 方法进行物理删除

## 2. 功能需求

### 2.1 数据表列表页面

**功能描述**：显示所有在白名单中且实际存在的表列表

**显示字段**：
- 表名（name）
- 来源（origin）：表所属的插件/模块
- 占用大小（size）：表+索引的总大小，单位：KB/MB/GB
- 数据条数（rowCount）
- 创建时间（createdAt）：表内数据最早的 createdAt，如果没有则为 null
- 最近更新时间（updatedAt）：表内数据最晚的 updatedAt，如果没有则使用最晚的 createdAt

**排序规则**：
- 默认按创建/修改时间倒序（优先使用 updatedAt，如果没有则使用 createdAt）
- 支持按各字段排序

**交互**：
- 点击表名进入详情页

### 2.2 数据表详情页面

**功能描述**：显示单个表的数据列表，支持筛选、备份、清理

#### 2.2.1 数据展示

**显示内容**：
- 数据列表（分页显示）
- 每条数据显示：创建时间、更新时间，其他字段可展开查看详情
- 默认显示全部数据（分页），筛选后只显示符合筛选条件的数据

**筛选功能**：
- 支持按 `createdAt` 筛选（时间范围）
- 支持按 `updatedAt` 筛选（时间范围）
- 支持 AND/OR 组合筛选（前端筛选组件支持）
- 如果表没有 `createdAt` 或 `updatedAt` 字段，禁用对应筛选并显示提示

**排序**：
- 默认按创建/修改时间倒序
- 支持按各字段排序

#### 2.2.2 备份功能

**流程**：
1. 用户设置筛选条件（可选）
2. 用户点击"备份"按钮
3. 系统执行备份操作（复用 module-backup 逻辑）
4. 备份完成后，用户可选择下载备份文件
5. 备份完成后，才能点击"清理"按钮

**备份文件**：
- 存储位置：`module-backup` 的备份目录（`storage/backups`）
- 文件命名格式：`db-clean_表名_YYYYMMDD_HHmmss_随机4位数.tbdump`（与 module-backup 格式相似，`module-backup` 格式为 `backup_YYYYMMDD_HHmmss_随机4位数.tbdump`，本插件添加 `db-clean_表名_` 前缀）
- 文件格式：与 `module-backup` 保持一致（`.tbdump` 格式）

**备份内容**：
- 备份符合筛选条件的数据
- 如果没有筛选条件，备份全部数据
- 保存筛选条件到备份文件的 meta 中

#### 2.2.3 清理功能

**流程**：
1. 用户设置筛选条件（可选）
2. 用户必须先完成备份（可选下载）
3. 用户点击"清理"按钮
4. 系统弹出二次确认弹窗
5. 用户确认后执行清理操作
6. 清理符合筛选条件的数据

**清理实现**：
- 使用 `repository.destroy({ filter })` 方法
- 物理删除数据（不是逻辑删除）
- 如果表没有时间字段，按默认顺序排序
- **索引维护**：PostgreSQL 在执行 DELETE 操作时会自动维护索引，无需手动重建索引。删除数据后，索引会自动更新。如果删除了大量数据，PostgreSQL 会在后台自动执行 VACUUM 来回收空间和更新统计信息，无需手动操作

**并发控制**：
- 同一表不允许同时进行备份和清理操作
- 使用锁机制防止并发（如文件锁或 Redis 锁）
- 前端逻辑：备份完成后才能点击清理按钮

**错误处理**：
- 清理失败时返回具体错误信息
- 不进行回滚操作（失败就是没删掉）
- 不需要审计日志

## 3. 技术实现方案

### 3.1 白名单配置

**位置**：`src/server/constants.ts`

```typescript
export const WHITELIST_TABLES = [
  // 手动添加需要清理的表名
  // 'users',
  // 'orders',
  // 'logs',
];
```

### 3.2 数据库适配

**PostgreSQL 特定实现**：

- **表大小**：使用 `pg_total_relation_size()` 函数获取表+索引总大小
- **行数统计**：使用 `COUNT(*)` 查询
- **时间字段统计**：使用 `MIN(createdAt)` 和 `MAX(updatedAt)` 查询

**其他数据库**：
- 保留扩展接口，暂不做功能实现

### 3.3 备份实现

**复用 module-backup**：
- 调用 `module-backup` 的 `Dumper` 类或相关方法
- 支持筛选条件的备份需要扩展或自定义实现
- 备份文件格式与 `module-backup` 保持一致

**筛选备份实现**：
- 构建带 WHERE 条件的 SQL 查询
- 查询符合筛选条件的数据
- 使用 `FieldValueWriter` 处理字段值
- 生成备份文件（zip 格式，包含 meta 和 data）

### 3.4 清理实现

**使用通用方法**：
- 使用 `repository.destroy({ filter })` 方法
- 支持标准的 filter 格式（Sequelize 会处理 SQL 注入防护）
- 如果表没有时间字段，按默认顺序排序

**并发控制**：
- 使用文件锁或 Redis 锁机制
- 同一表同一时间只能执行一个操作（备份或清理）

### 3.5 筛选条件

**格式**：标准 Sequelize filter 格式

```typescript
{
  createdAt: {
    $gte: '2024-01-01T00:00:00Z',
    $lte: '2024-12-31T23:59:59Z'
  },
  updatedAt: {
    $gte: '2024-01-01T00:00:00Z',
    $lte: '2024-12-31T23:59:59Z'
  }
}
```

**安全性**：
- Sequelize 的 filter 已处理 SQL 注入防护
- 如果存在风险，考虑使用自定义字段格式，后端转换

## 4. API 设计

### 4.1 Resource 命名

**Resource 名称**：`databaseClean`

### 4.2 API 端点

#### 4.2.1 获取表列表

**端点**：`GET /databaseClean:list`

**参数**：
- `page`：页码（默认 1）
- `pageSize`：每页数量（默认 20）
- `sort`：排序字段（默认按 updatedAt 倒序）

**响应**：
```json
{
  "count": 10,
  "rows": [
    {
      "name": "users",
      "origin": "@tachybase/module-user",
      "size": 1024000,
      "rowCount": 1000,
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-12-31T23:59:59Z"
    }
  ],
  "page": 1,
  "pageSize": 20,
  "totalPage": 1
}
```

#### 4.2.2 获取表信息

**端点**：`GET /databaseClean:get`

**参数**：
- `filterByTk`：表名

**响应**：
```json
{
  "name": "users",
  "origin": "@tachybase/module-user",
  "size": 1024000,
  "rowCount": 1000,
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-12-31T23:59:59Z",
  "hasCreatedAt": true,
  "hasUpdatedAt": true
}
```

#### 4.2.3 获取表数据

**端点**：`GET /databaseClean:data`

**参数**：
- `filterByTk`：表名
- `page`：页码（默认 1）
- `pageSize`：每页数量（默认 20）
- `filter`：筛选条件（标准格式）
- `sort`：排序字段

**响应**：
```json
{
  "count": 100,
  "rows": [
    {
      "id": 1,
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-12-31T23:59:59Z",
      // ... 其他字段
    }
  ],
  "page": 1,
  "pageSize": 20,
  "totalPage": 5
}
```

#### 4.2.4 备份数据

**端点**：`POST /databaseClean:backup`

**参数**：
```json
{
  "collectionName": "users",
  "filter": {
    "createdAt": {
      "$gte": "2024-01-01T00:00:00Z",
      "$lte": "2024-12-31T23:59:59Z"
    }
  }
}
```

**响应**：
```json
{
  "fileName": "db-clean_users_20240101_120000.tbdump",
  "filePath": "/path/to/backup/db-clean_users_20240101_120000.tbdump",
  "status": "success"
}
```

**并发控制**：
- 同一表同一时间只能执行一个备份操作
- 返回锁状态或错误信息

#### 4.2.5 清理数据

**端点**：`POST /databaseClean:clean`

**参数**：
```json
{
  "collectionName": "users",
  "filter": {
    "createdAt": {
      "$gte": "2024-01-01T00:00:00Z",
      "$lte": "2024-12-31T23:59:59Z"
    }
  }
}
```

**响应**：
```json
{
  "deletedCount": 100,
  "status": "success"
}
```

**错误响应**：
```json
{
  "error": "清理失败：具体错误信息",
  "status": "error"
}
```

**并发控制**：
- 同一表同一时间只能执行一个清理操作
- 必须在前一个备份完成后才能执行清理

#### 4.2.6 下载备份文件

**端点**：`GET /databaseClean:download`

**参数**：
- `filterByTk`：备份文件名

**响应**：文件流

## 5. 权限控制

### 5.1 ACL Snippet

**名称**：`pm.database-clean.*`

**权限范围**：
- `databaseClean:*`：所有操作权限
- `databaseClean:list`：查看表列表
- `databaseClean:get`：查看表信息
- `databaseClean:data`：查看表数据
- `databaseClean:backup`：备份数据
- `databaseClean:clean`：清理数据
- `databaseClean:download`：下载备份文件

### 5.2 权限配置

在插件加载时注册 ACL snippet：

```typescript
this.app.acl.registerSnippet({
  name: 'pm.database-clean.*',
  actions: ['databaseClean:*'],
});
```

## 6. 前端页面设计

### 6.1 列表页面

**路由**：`/admin/database-clean`

**组件结构**：
- 表格组件：显示表列表
- 分页组件：支持分页
- 排序功能：支持按各字段排序

**交互**：
- 点击表名进入详情页
- 显示表大小（友好格式：KB/MB/GB）

### 6.2 详情页面

**路由**：`/admin/database-clean/:tableName`

**组件结构**：
- 数据表格：显示数据列表（分页）
- 筛选组件：时间范围筛选（createdAt/updatedAt）
- 备份按钮：执行备份操作
- 清理按钮：执行清理操作（需要先备份）

**交互流程**：
1. 用户进入详情页，默认显示全部数据
2. 用户设置筛选条件（可选）
3. 筛选后，表格只显示符合条件的数据
4. 用户点击"备份"按钮
5. 备份完成后，显示下载链接（可选）
6. 备份完成后，"清理"按钮变为可用状态
7. 用户点击"清理"按钮
8. 弹出二次确认弹窗
9. 用户确认后执行清理
10. 清理完成后刷新数据列表

**状态管理**：
- 是否已备份：记录备份状态
- 筛选条件：记录当前筛选条件
- 锁定状态：防止并发操作

## 7. 错误处理

### 7.1 备份错误

- 备份失败：返回错误信息，清理临时文件
- 并发冲突：返回锁定状态，提示稍后重试

### 7.2 清理错误

- 清理失败：返回具体错误信息
- 并发冲突：返回锁定状态，提示稍后重试
- 未备份：前端限制，后端也做校验

### 7.3 表不存在或不在白名单

- 返回 404 或错误信息
- 前端显示友好提示

### 7.4 表没有时间字段

- 详情页禁用时间筛选
- 显示提示信息："该表不支持时间筛选"

## 8. 文件结构

```
packages/plugin-database-clean/
├── src/
│   ├── server/
│   │   ├── constants.ts              # 白名单配置
│   │   ├── services/
│   │   │   ├── database-clean-service.ts      # 表信息查询服务
│   │   │   ├── filtered-backup-service.ts    # 筛选备份服务
│   │   │   └── clean-service.ts                # 清理服务
│   │   ├── resourcers/
│   │   │   └── database-clean.ts              # API 路由定义
│   │   ├── utils/
│   │   │   └── lock.ts                        # 并发控制锁
│   │   └── plugin.ts                          # 插件主文件
│   ├── client/
│   │   ├── pages/
│   │   │   ├── TableList.tsx                  # 列表页面
│   │   │   └── TableDetail.tsx                # 详情页面
│   │   ├── components/
│   │   │   ├── TableSize.tsx                  # 表大小显示组件
│   │   │   └── FilterPanel.tsx                # 筛选面板组件
│   │   └── plugin.tsx                         # 客户端插件
│   └── index.ts
├── package.json
└── README.md
```

## 9. 实现计划

### 9.1 第一阶段：服务端基础功能

1. 定义白名单常量
2. 实现数据库清理服务（表信息查询）
3. 实现筛选备份服务
4. 实现清理服务
5. 实现并发控制锁机制
6. 注册 API 路由
7. 配置 ACL 权限

### 9.2 第二阶段：前端页面

1. 实现列表页面
2. 实现详情页面
3. 实现筛选组件
4. 实现备份流程
5. 实现清理流程
6. 错误处理和提示

### 9.3 第三阶段：测试和优化

1. 单元测试
2. 集成测试
3. 性能优化
4. 用户体验优化

## 10. 注意事项

### 10.1 安全性

- 所有操作都需要 ACL 权限验证
- 筛选条件使用 Sequelize 标准格式，防止 SQL 注入
- 只允许操作白名单中的表

### 10.2 性能

- 大批量清理时考虑分批处理
- 表大小查询使用缓存（可选）
- 数据列表查询使用分页

### 10.3 用户体验

- 备份和清理操作提供进度提示
- 错误信息友好提示
- 操作确认提示清晰

### 10.4 扩展性

- 其他数据库的适配保留接口
- 白名单配置可扩展
- 备份和清理逻辑可扩展

## 11. 依赖

- `@tego/server`：服务器框架
- `@tego/client`：客户端框架
- `@tachybase/module-backup`：备份模块（复用备份逻辑）
- `archiver`：文件打包
- `dayjs`：时间处理
- `lodash`：工具函数

## 12. 版本信息

- **版本**：1.3.25
- **创建日期**：2024-01-01
- **最后更新**：2024-01-01

