---
description: Frontend state management - hooks, local state, API client
globs:
  - packages/**/*.tsx
alwaysApply: false
---

# Frontend State Management / 前端状态管理

## Using @tachybase/client Hooks / 使用 @tachybase/client Hooks

```typescript
import { useRequest } from '@tachybase/client';

const { data, loading, refresh } = useRequest({
  resource: 'users',
  action: 'list',
});
```

## Local State / 本地状态

```typescript
const [count, setCount] = useState(0);

// Complex state use useReducer / 复杂状态使用 useReducer
const [state, dispatch] = useReducer(reducer, initialState);
```
