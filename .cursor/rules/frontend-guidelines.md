# Frontend Development Guidelines / 前端开发指南

## Purpose / 目的

Establish consistent frontend development patterns and best practices for Tego Standard project.

为 Tego Standard 项目建立一致的前端开发模式和最佳实践。

## When to Use This Guide / 何时使用此指南

Automatically activated in the following situations:
在以下情况下自动激活：

- Creating or modifying React components / 创建或修改 React 组件
- Handling state management / 处理状态管理
- Implementing routing and navigation / 实现路由和导航
- Styling and theming / 样式和主题
- Performance optimization / 性能优化
- TypeScript type definitions / TypeScript 类型定义
- Frontend testing / 前端测试

---

## Quick Start / 快速开始

### New Component Checklist / 新组件清单

- [ ] **Component Structure / 组件结构**：Clear component hierarchy / 清晰的组件层次
- [ ] **Type Definitions / 类型定义**：Complete TypeScript types / 完整的 TypeScript 类型
- [ ] **State Management / 状态管理**：Proper use of hooks / 合理使用 hooks
- [ ] **Styling / 样式**：Consistent styling approach / 一致的样式方案
- [ ] **Error Handling / 错误处理**：Loading and error states / 加载和错误状态
- [ ] **Testing / 测试**：Component tests / 组件测试
- [ ] **Internationalization / 国际化**：Translation keys added to all locale files / 翻译键添加到所有语言文件

---

## Component Patterns / 组件模式

### Functional Components / 函数组件

Use functional components and Hooks:
使用函数组件和 Hooks：

```typescript
import React from 'react';
import { useTranslation } from 'react-i18next';

interface UserCardProps {
  user: {
    id: string;
    name: string;
    email: string;
  };
  onEdit?: (id: string) => void;
}

export const UserCard: React.FC<UserCardProps> = ({ user, onEdit }) => {
  const { t } = useTranslation();
  
  return (
    <div className="user-card">
      <h3>{user.name}</h3>
      <p>{user.email}</p>
      {onEdit && (
        <button onClick={() => onEdit(user.id)}>
          {t('Edit')}
        </button>
      )}
    </div>
  );
};
```

### Schema Components / Schema 组件

Use SchemaComponent for declarative UI:
使用 SchemaComponent 进行声明式 UI：

```typescript
import { SchemaComponent } from '@tachybase/client';

const schema = {
  type: 'void',
  'x-component': 'Card',
  properties: {
    title: {
      type: 'string',
      'x-component': 'Input',
      title: '{{t("Title")}}',
    },
  },
};

<SchemaComponent schema={schema} />
```

### Custom Hooks / 自定义 Hooks

Extract reusable logic:
提取可复用的逻辑：

```typescript
import { useState, useEffect } from 'react';
import { useAPIClient } from '@tachybase/client';

export function useUser(userId: string) {
  const api = useAPIClient();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.resource('users').get({ filterByTk: userId })
      .then(({ data }) => setUser(data))
      .catch(setError)
      .finally(() => setLoading(false));
  }, [userId, api]);

  return { user, loading, error };
}
```

---

## File Organization / 文件组织

### Module/Plugin Client Structure / 模块/插件客户端结构

```
packages/module-*/src/client/
├── components/         # React components / React 组件
│   ├── UserList.tsx
│   └── UserCard.tsx
├── hooks/              # Custom hooks / 自定义 hooks
│   └── useUser.ts
├── locale/             # Translation files / 翻译文件
│   ├── en-US.json
│   └── zh-CN.json
└── index.ts            # Exports / 导出
```

---

## State Management / 状态管理

### Using @tachybase/client Hooks / 使用 @tachybase/client Hooks

```typescript
import { useRequest } from '@tachybase/client';

const { data, loading, refresh } = useRequest({
  resource: 'users',
  action: 'list',
});
```

### Local State / 本地状态

```typescript
const [count, setCount] = useState(0);

// Complex state use useReducer / 复杂状态使用 useReducer
const [state, dispatch] = useReducer(reducer, initialState);
```

---

## TypeScript Best Practices / TypeScript 最佳实践

### Type Definitions / 类型定义

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

### Props Types / Props 类型

```typescript
interface ComponentProps {
  required: string;
  optional?: number;
  callback: (value: string) => void;
}
```

---

## Performance Optimization / 性能优化

### React.memo / React.memo

Avoid unnecessary re-renders:
避免不必要的重渲染：

```typescript
export const UserCard = React.memo<UserCardProps>(({ user }) => {
  // Component implementation / 组件实现
});
```

### useMemo and useCallback / useMemo 和 useCallback

```typescript
const expensiveValue = useMemo(() => {
  return computeExpensiveValue(a, b);
}, [a, b]);

const handleClick = useCallback(() => {
  doSomething(id);
}, [id]);
```

---

## Internationalization / 国际化

### Using Translations / 使用翻译

```typescript
import { useTranslation } from 'react-i18next';

const { t } = useTranslation();

<Button>{t('Save')}</Button>
```

### Adding Translation Keys / 添加翻译键

**Important / 重要**：Must add translation keys to ALL language files / 必须将翻译键添加到所有语言文件：

```json
// en-US.json
{
  "Save": "Save",
  "Cancel": "Cancel"
}

// zh-CN.json (must also add) / 必须也添加
{
  "Save": "保存",
  "Cancel": "取消"
}

// ko_KR.json (must also add) / 必须也添加
{
  "Save": "저장",
  "Cancel": "취소"
}
```

---

## Best Practices / 最佳实践

1. **Component Single Responsibility / 组件单一职责**：Each component does one thing / 每个组件只做一件事
2. **Type Safety / 类型安全**：Fully utilize TypeScript / 充分利用 TypeScript
3. **Performance Optimization / 性能优化**：Avoid unnecessary re-renders / 避免不必要的重渲染
4. **Accessibility / 可访问性**：Follow a11y standards / 遵循 a11y 标准
5. **Test Coverage / 测试覆盖**：Write tests for critical components / 为关键组件编写测试
6. **Internationalization / 国际化**：Always add translations to all locale files / 始终将所有翻译添加到所有语言文件

