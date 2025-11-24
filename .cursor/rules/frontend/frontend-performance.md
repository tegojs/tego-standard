---
description: Frontend performance optimization - React.memo, useMemo, useCallback
globs:
  - packages/**/*.tsx
alwaysApply: false
---

# Frontend Performance / 前端性能优化

## React.memo / React.memo

Avoid unnecessary re-renders:

```typescript
export const UserCard = React.memo<UserCardProps>(({ user }) => {
  // Component implementation
});
```

## useMemo and useCallback / useMemo 和 useCallback

```typescript
const expensiveValue = useMemo(() => {
  return computeExpensiveValue(a, b);
}, [a, b]);

const handleClick = useCallback(() => {
  doSomething(id);
}, [id]);
```
