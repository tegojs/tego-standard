# @tachybase/plugin-database-clean

数据库清理插件 - 用于查看数据表占用和清理数据表

## 功能特性

- 📊 **表概览**：查看白名单数据表的占用大小、数据条数、创建时间、更新时间
- 🔍 **数据筛选**：支持按 createdAt/updatedAt 时间范围或 ID 范围筛选
- 💾 **数据备份**：清理前备份筛选数据（`.tbdump` 格式，兼容 module-backup）
- 🗑️ **数据清理**：安全的物理删除操作，支持筛选数据清理
- 📦 **分批清理**：支持大数据量分批清理（按批数或每批条数分割，最多 1000 批）
- 🔄 **空间释放**：清理后可选执行 VACUUM FULL 释放磁盘空间
- 🔒 **安全控制**：白名单机制，只允许操作指定的表
- 🏗️ **数据库适配器**：可扩展的适配器架构，便于未来支持其他数据库（目前仅支持 PostgreSQL）

## 安装

```bash
pnpm pm add @tachybase/plugin-database-clean
pnpm pm enable @tachybase/plugin-database-clean
```

## 使用

### 配置白名单

在 `src/server/constants.ts` 中配置白名单表：

```typescript
export const WHITELIST_TABLES = [
  'users',
  'orders',
  'logs',
];
```

### 权限配置

插件会自动注册 ACL snippet：`pm.database-clean.*`

在角色权限中配置相应权限即可使用。

## 界面操作流程

1. **表列表页面**：查看所有白名单表的大小、数据条数和时间信息
2. **表详情页面**：
   - 分页查看表数据
   - 按时间范围（createdAt/updatedAt）或 ID 范围筛选
   - 点击"清理"按钮开始清理流程
3. **清理流程**：
   - 第一步：选择先备份还是直接清理
   - 第二步：如果备份，可选择下载备份文件
   - 第三步：配置分批设置（不分批 / 分为 N 批 / 每批 N 条）
   - 第四步：选择是否释放磁盘空间（VACUUM FULL）
   - 清理过程中：按钮显示进度，如 "(1/100) 清理中..."

## API

### 获取表列表

```
GET /databaseClean:list
```

### 获取表信息

```
GET /databaseClean:get?filterByTk=表名
```

返回：表信息，包含 `hasCreatedAt`、`hasUpdatedAt`、`minId`、`maxId`

### 获取表数据

```
GET /databaseClean:data?filterByTk=表名&page=1&pageSize=20&filter=...
```

返回：分页数据，包含 `filteredMinId`、`filteredMaxId` 用于分批清理

### 备份数据

```
POST /databaseClean:backup
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

### 清理数据

```
POST /databaseClean:clean
{
  "collectionName": "users",
  "filter": {
    "createdAt": {
      "$gte": "2024-01-01T00:00:00Z",
      "$lte": "2024-12-31T23:59:59Z"
    }
  },
  "vacuum": true  // 可选：清理后执行 VACUUM FULL
}
```

### 下载备份文件

```
GET /databaseClean:download?filterByTk=db-clean_users_20240101_120000.tbdump
```

## 备份文件格式

备份文件使用 `.tbdump` 格式（兼容 `module-backup`）：
- 文件名：`db-clean_{表名}_{筛选范围}_{时间戳}_{随机数}.tbdump`
- 内容：JSON 格式的数据及元信息
- 可通过标准备份恢复流程进行恢复

## 注意事项

- 目前仅支持 PostgreSQL 数据库
- 只允许操作白名单中的表
- 清理前备份是可选的（建议备份但不强制）
- 清理操作是物理删除，请谨慎操作
- **VACUUM FULL**：执行时会锁定数据表，对于大表可能需要较长时间
- **分批清理**：对于大数据量，建议使用分批清理以避免长时间事务
- **索引维护**：PostgreSQL 在执行 DELETE 操作时会自动维护索引，无需手动重建

## 文档

详细的需求和实现文档请参考 [REQUIREMENTS.md](./REQUIREMENTS.md)

