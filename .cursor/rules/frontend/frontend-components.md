---
description: React component patterns - functional components, SchemaComponent, custom hooks
globs:
  - packages/**/*.tsx
  - packages/client/src/**/*.tsx
alwaysApply: false
---

# Frontend Component Patterns / 前端组件模式

## Functional Components / 函数组件

Use functional components and Hooks:

```typescript
interface UserCardProps {
  user: { id: string; name: string; email: string };
  onEdit?: (id: string) => void;
}

export const UserCard: React.FC<UserCardProps> = ({ user, onEdit }) => {
  const { t } = useTranslation();
  return <div className="user-card">{user.name}</div>;
};
```

## Schema Components / Schema 组件

Use SchemaComponent for declarative UI:

```typescript
import { SchemaComponent } from '@tachybase/client';

const schema = {
  type: 'void',
  'x-component': 'Card',
  properties: { title: { type: 'string', 'x-component': 'Input' } },
};

<SchemaComponent schema={schema} />
```
