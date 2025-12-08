---
description: Backend architecture - layered architecture, module/plugin structure
globs:
  - packages/module-*/src/**/*.ts
  - packages/plugin-*/src/**/*.ts
alwaysApply: false
---

# Backend Architecture / 后端架构

## Layered Architecture / 分层架构

```
HTTP Request → Routes → Controllers → Services → Repositories → Database
```

**Core Principle / 核心原则**: Each layer has only one responsibility.
**核心原则**：每一层只有一个职责。

## Module/Plugin Structure / 模块/插件结构

```
packages/module-*/src/
├── server/              # Server-side code
│   ├── collections/    # Collection definitions
│   ├── migrations/     # Database migrations
│   ├── actions/        # Actions
│   └── index.ts        # Plugin entry
└── client/             # Client-side code (if any)
```
