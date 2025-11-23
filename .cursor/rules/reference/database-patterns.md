---
description: Database patterns and Prisma best practices for data modeling and queries
globs:
  - packages/module-*/src/**/*.ts
  - **/prisma/**/*.ts
  - **/schema.prisma
  - **/database/**/*.ts
alwaysApply: false
---

# Database Patterns and Best Practices / 数据库模式和最佳实践

## Purpose / 目的

Establish consistent database development patterns and best practices for Tego Standard project.

为 Tego Standard 项目建立一致的数据库开发模式和最佳实践。

## When to Use This Guide / 何时使用此指南

Automatically activated in the following situations:
在以下情况下自动激活：

- Creating or modifying database schemas / 创建或修改数据库模式
- Writing migrations / 编写迁移
- Defining collections / 定义集合
- Database queries and operations / 数据库查询和操作
- Performance optimization / 性能优化

---

## Collection Definition / 集合定义

### Basic Collection / 基本集合

```typescript
this.app.db.defineCollection({
  name: 'users',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'email', type: 'string', unique: true },
    { name: 'age', type: 'integer' },
    { name: 'createdAt', type: 'date', defaultValue: () => new Date() },
  ],
  indexes: [
    { fields: ['email'] },
    { fields: ['createdAt'] },
  ],
});
```

### Collection with Relations / 带关系的集合

```typescript
this.app.db.defineCollection({
  name: 'posts',
  fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'content', type: 'text' },
    { name: 'authorId', type: 'belongsTo', target: 'users' },
    { name: 'comments', type: 'hasMany', target: 'comments' },
  ],
});
```

---

## Migrations / 迁移

### Creating Migrations / 创建迁移

```bash
pnpm tachybase create-migration migration-name --pkg=@tachybase/module-name --on=afterSync
```

### Migration Structure / 迁移结构

```typescript
import { Migration } from '@tachybase/server';

export default class extends Migration {
  on = 'afterSync'; // 'beforeLoad' | 'afterSync' | 'afterLoad'
  appVersion = '<1.5.0';

  async up() {
    // Create collection / 创建集合
    await this.db.getRepository('collections').create({
      values: {
        name: 'newCollection',
        fields: [
          { name: 'title', type: 'string' },
        ],
      },
    });
  }

  async down() {
    // Rollback logic / 回滚逻辑
    await this.db.getRepository('collections').destroy({
      filterByTk: 'newCollection',
    });
  }
}
```

### Migration Best Practices / 迁移最佳实践

1. **Always test migrations / 始终测试迁移**：Test in development before deploying / 部署前在开发环境测试
2. **Make migrations reversible / 使迁移可逆**：Implement `down()` method / 实现 `down()` 方法
3. **Use transactions / 使用事务**：Wrap operations in transactions when possible / 尽可能在事务中包装操作
4. **Version constraints / 版本约束**：Use `appVersion` to control when migrations run / 使用 `appVersion` 控制迁移运行时机

---

## Query Patterns / 查询模式

### Using Repository / 使用仓库

```typescript
// List records / 列出记录
const users = await ctx.db.getRepository('users').find({
  filter: {
    status: 'active',
  },
  sort: ['createdAt'],
  page: 1,
  pageSize: 20,
});

// Get single record / 获取单个记录
const user = await ctx.db.getRepository('users').findOne({
  filterByTk: userId,
});

// Create record / 创建记录
const newUser = await ctx.db.getRepository('users').create({
  values: {
    name: 'John',
    email: 'john@example.com',
  },
});

// Update record / 更新记录
await ctx.db.getRepository('users').update({
  filterByTk: userId,
  values: {
    name: 'Jane',
  },
});

// Delete record / 删除记录
await ctx.db.getRepository('users').destroy({
  filterByTk: userId,
});
```

---

## Performance Optimization / 性能优化

### Indexes / 索引

```typescript
this.app.db.defineCollection({
  name: 'users',
  fields: [
    { name: 'email', type: 'string' },
    { name: 'status', type: 'string' },
  ],
  indexes: [
    { fields: ['email'], unique: true },      // Unique index / 唯一索引
    { fields: ['status'] },                   // Regular index / 普通索引
    { fields: ['email', 'status'] },         // Composite index / 复合索引
  ],
});
```

### Query Optimization / 查询优化

1. **Use indexes / 使用索引**：Create indexes for frequently queried fields / 为频繁查询的字段创建索引
2. **Limit fields / 限制字段**：Only select needed fields / 只选择需要的字段
3. **Pagination / 分页**：Always use pagination for large datasets / 对大数据集始终使用分页
4. **Avoid N+1 queries / 避免 N+1 查询**：Use associations properly / 正确使用关联

---

## Best Practices / 最佳实践

1. **Schema Design / 模式设计**：Design with scalability in mind / 设计时考虑可扩展性
2. **Migration Safety / 迁移安全**：Always test migrations before deploying / 部署前始终测试迁移
3. **Data Integrity / 数据完整性**：Use constraints and validations / 使用约束和验证
4. **Performance / 性能**：Create indexes for frequently queried fields / 为频繁查询的字段创建索引
5. **Transactions / 事务**：Use transactions for related operations / 对相关操作使用事务
6. **Backup / 备份**：Regular backups before migrations / 迁移前定期备份

