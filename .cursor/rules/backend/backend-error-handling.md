---
description: Backend error handling - unified error handling mechanism
globs:
  - packages/module-*/src/**/*.ts
  - packages/plugin-*/src/**/*.ts
alwaysApply: false
---

# Backend Error Handling / 后端错误处理

## Unified Error Handling / 统一错误处理

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
