# Backend Development Guidelines / 后端开发指南

## Purpose / 目的

Establish consistent backend development patterns and best practices for Tego Standard project.

为 Tego Standard 项目建立一致的后端开发模式和最佳实践。

## When to Use This Guide / 何时使用此指南

Automatically activated in the following situations:
在以下情况下自动激活：

- Creating or modifying routes, endpoints, APIs / 创建或修改路由、端点、API
- Building controllers, services, repositories / 构建控制器、服务、仓库
- Implementing middleware (authentication, validation, error handling) / 实现中间件（认证、验证、错误处理）
- Database operations (Prisma, Sequelize) / 数据库操作（Prisma, Sequelize）
- Error tracking and monitoring / 错误跟踪和监控
- Configuration management / 配置管理
- Backend testing and refactoring / 后端测试和重构

---

## Quick Start / 快速开始

### New Backend Feature Checklist / 新后端功能清单

- [ ] **Routes / 路由**：Clear definition, delegate to controllers / 清晰定义，委托给控制器
- [ ] **Controllers / 控制器**：Handle requests, call services / 处理请求，调用服务
- [ ] **Services / 服务**：Business logic, dependency injection / 业务逻辑，依赖注入
- [ ] **Repositories / 仓库**：Data access (if needed) / 数据库访问（如需要）
- [ ] **Validation / 验证**：Input validation / 输入验证
- [ ] **Error Handling / 错误处理**：Unified error handling / 统一错误处理
- [ ] **Testing / 测试**：Unit tests + integration tests / 单元测试 + 集成测试

---

## Architecture Overview / 架构概述

### Layered Architecture / 分层架构

```
HTTP Request / HTTP 请求
    ↓
Routes (route definitions only) / 路由（仅路由定义）
    ↓
Controllers (request handling) / 控制器（请求处理）
    ↓
Services (business logic) / 服务（业务逻辑）
    ↓
Repositories (data access) / 仓库（数据访问）
    ↓
Database (Prisma/Sequelize) / 数据库
```

**Core Principle / 核心原则**：Each layer has only one responsibility. / 每一层只有一个职责。

---

## Module/Plugin Structure / 模块/插件结构

### Module Structure / 模块结构

```
packages/module-*/src/
├── server/              # Server-side code / 服务端代码
│   ├── collections/    # Collection definitions / 集合定义
│   ├── migrations/     # Database migrations / 数据库迁移
│   ├── actions/        # Actions / 动作
│   ├── hooks/          # Hooks / 钩子
│   └── index.ts        # Plugin entry / 插件入口
└── client/             # Client-side code (if any) / 客户端代码（如有）
    └── components/      # React components / React 组件
```

### Plugin Structure / 插件结构

```
packages/plugin-*/src/
├── server/              # Server-side code / 服务端代码
│   ├── collections/    # Collection definitions / 集合定义
│   ├── migrations/     # Database migrations / 数据库迁移
│   ├── actions/        # Actions / 动作
│   └── index.ts        # Plugin entry / 插件入口
└── client/             # Client-side code / 客户端代码
    └── components/     # React components / React 组件
```

---

## Core Patterns / 核心模式

### 1. Plugin/Module Registration / 插件/模块注册

```typescript
import { Plugin } from '@tego/server';

export class MyModulePlugin extends Plugin {
  async load() {
    // Register collections / 注册集合
    this.app.db.defineCollection({
      name: 'myCollection',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'content', type: 'text' },
      ],
    });

    // Register actions / 注册动作
    this.app.actions.register('my-action', async (ctx) => {
      // Action logic / 动作逻辑
    });
  }
}
```

### 2. Collection Definition / 集合定义

```typescript
this.app.db.defineCollection({
  name: 'users',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'email', type: 'string', unique: true },
    { name: 'age', type: 'integer' },
  ],
  indexes: [
    { fields: ['email'] },
  ],
});
```

### 3. Action Implementation / 动作实现

```typescript
this.app.actions.register('users:create', async (ctx) => {
  const { values } = ctx.action.params;
  
  // Validation / 验证
  if (!values.name || !values.email) {
    throw new Error('Name and email are required');
  }
  
  // Business logic / 业务逻辑
  const user = await ctx.db.getRepository('users').create({
    values: {
      name: values.name,
      email: values.email,
    },
  });
  
  return user;
});
```

### 4. Migration Pattern / 迁移模式

```typescript
import { Migration } from '@tachybase/server';

export default class extends Migration {
  on = 'afterSync'; // 'beforeLoad' | 'afterSync' | 'afterLoad'
  appVersion = '<1.5.0';

  async up() {
    // Migration logic / 迁移逻辑
    await this.db.getRepository('collections').create({
      values: {
        name: 'newCollection',
        // ...
      },
    });
  }
}
```

---

## Error Handling / 错误处理

### Unified Error Handling / 统一错误处理

```typescript
try {
  // Business logic / 业务逻辑
} catch (error) {
  // Log error / 记录错误
  ctx.logger.error('Error occurred:', error);
  
  // Return appropriate error response / 返回适当的错误响应
  throw new Error(`Operation failed: ${error.message}`);
}
```

---

## Best Practices / 最佳实践

1. **Single Responsibility / 单一职责**：Each class/function does one thing / 每个类/函数只做一件事
2. **Dependency Injection / 依赖注入**：Inject dependencies through constructor / 通过构造函数注入依赖
3. **Error Handling / 错误处理**：Unified error handling mechanism / 统一错误处理机制
4. **Type Safety / 类型安全**：Fully utilize TypeScript type system / 充分利用 TypeScript 类型系统
5. **Test Coverage / 测试覆盖**：Write tests for critical business logic / 为关键业务逻辑编写测试
6. **Migration Safety / 迁移安全**：Always test migrations before deploying / 部署前始终测试迁移
7. **Collection Design / 集合设计**：Design collections with scalability in mind / 设计集合时考虑可扩展性

