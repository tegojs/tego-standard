---
description: Frontend TypeScript best practices - type definitions, props types
globs:
  - packages/**/*.tsx
alwaysApply: false
---

# Frontend TypeScript Best Practices / 前端 TypeScript 最佳实践

## Type Definitions / 类型定义

```typescript
// types/user.ts
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export type UserStatus = 'active' | 'inactive' | 'pending';
```

## Props Types / Props 类型

```typescript
interface ComponentProps {
  required: string;
  optional?: number;
  callback: (value: string) => void;
}
```
