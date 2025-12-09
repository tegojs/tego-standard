---
description: Backend core patterns - plugin registration, collections, actions, migrations
globs:
  - packages/module-*/src/**/*.ts
  - packages/plugin-*/src/**/*.ts
alwaysApply: false
---

# Backend Core Patterns / 后端核心模式

## Plugin/Module Registration / 插件/模块注册

```typescript
import { Plugin } from '@tego/server';

export class MyModulePlugin extends Plugin {
  async load() {
    this.app.db.defineCollection({
      name: 'myCollection',
      fields: [{ name: 'title', type: 'string' }],
    });
  }
}
```

## Collection Definition / 集合定义

```typescript
this.app.db.defineCollection({
  name: 'users',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'email', type: 'string', unique: true },
  ],
});
```

## Action Implementation / 动作实现

```typescript
this.app.actions.register('users:create', async (ctx) => {
  const { values } = ctx.action.params;
  if (!values.name || !values.email) {
    throw new Error('Name and email are required');
  }
  return await ctx.db.getRepository('users').create({ values });
});
```
