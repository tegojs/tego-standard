---
description: Backend best practices - single responsibility, dependency injection, error handling
globs:
  - packages/module-*/src/**/*.ts
  - packages/plugin-*/src/**/*.ts
alwaysApply: false
---

# Backend Best Practices / 后端最佳实践

1. **Single Responsibility / 单一职责**: Each class/function does one thing.
2. **Dependency Injection / 依赖注入**: Inject dependencies through constructor.
3. **Error Handling / 错误处理**: Unified error handling mechanism.
4. **Type Safety / 类型安全**: Fully utilize TypeScript type system.
5. **Test Coverage / 测试覆盖**: Write tests for critical business logic.
6. **Migration Safety / 迁移安全**: Always test migrations before deploying.
7. **Collection Design / 集合设计**: Design collections with scalability in mind.
