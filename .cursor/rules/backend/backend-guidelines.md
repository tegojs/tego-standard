---
description: Backend development overview - see specific rule files for details
globs:
  - packages/module-*/src/**/*.ts
  - packages/plugin-*/src/**/*.ts
  - packages/*/src/server/**/*.ts
  - **/server/**/*.ts
alwaysApply: false
---

# Backend Development Guidelines / 后端开发指南

This file provides an overview. For detailed guidelines, see:
本文件提供概览。详细指南请参见：

- `backend-architecture.md` - Architecture and structure
- `backend-patterns.md` - Core patterns (plugins, collections, actions, migrations)
- `backend-error-handling.md` - Error handling
- `backend-best-practices.md` - Best practices

## Quick Start / 快速开始

### New Backend Feature Checklist / 新后端功能清单

- [ ] **Routes / 路由**: Clear definition, delegate to controllers
- [ ] **Controllers / 控制器**: Handle requests, call services
- [ ] **Services / 服务**: Business logic, dependency injection
- [ ] **Repositories / 仓库**: Data access (if needed)
- [ ] **Validation / 验证**: Input validation
- [ ] **Error Handling / 错误处理**: Unified error handling
- [ ] **Testing / 测试**: Unit tests + integration tests

