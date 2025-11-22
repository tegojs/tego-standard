---
description: Specific rules for @tachybase/client package development
globs:
  - packages/client/src/**/*.ts
  - packages/client/src/**/*.tsx
alwaysApply: false
---

# Client Package Rules / Client 包规则

This file contains specific rules for the `packages/client` directory.

本文件包含 `packages/client` 目录的特定规则。

## Package Overview / 包概述

The `@tachybase/client` package is the core client library providing:
- Application framework and plugin system
- API client and data source management
- Schema components and UI building blocks
- React hooks and utilities

`@tachybase/client` 包是核心客户端库，提供：
- 应用框架和插件系统
- API 客户端和数据源管理
- Schema 组件和 UI 构建块
- React hooks 和工具函数

## Architecture Patterns / 架构模式

### Application Class / Application 类
- Use the `Application` class as the main entry point
- 使用 `Application` 类作为主入口点
- Initialize with `ApplicationOptions`
- 使用 `ApplicationOptions` 初始化

```typescript
// Example / 示例
import { Application } from '@tachybase/client';

const app = new Application({
  apiClient: {
    baseURL: '/api',
  },
  plugins: [],
  providers: [],
});
```

### API Client / API 客户端
- Use `APIClient` for all HTTP requests
- 使用 `APIClient` 进行所有 HTTP 请求
- Use `useAPIClient()` hook in React components
- 在 React 组件中使用 `useAPIClient()` hook

```typescript
// Example / 示例
import { useAPIClient } from '@tachybase/client';

const MyComponent = () => {
  const api = useAPIClient();
  const { data, loading } = useRequest(() => api.resource('users').list());
  // ...
};
```

### Schema Components / Schema 组件
- Use schema components for declarative UI
- 使用 schema 组件进行声明式 UI
- Follow the schema-first approach
- 遵循 schema 优先的方法

```typescript
// Example / 示例
import { SchemaComponent } from '@tachybase/client';

const schema = {
  type: 'void',
  'x-component': 'Card',
  properties: {
    title: {
      type: 'string',
      'x-component': 'Input',
    },
  },
};

<SchemaComponent schema={schema} />
```

## Code Patterns / 代码模式

### Hooks Usage / Hooks 使用
- Prefer custom hooks from `@tachybase/client`
- 优先使用 `@tachybase/client` 的自定义 hooks
- Use `useRequest` for data fetching
- 使用 `useRequest` 进行数据获取

```typescript
// Example / 示例
import { useRequest } from '@tachybase/client';

const { data, loading, refresh } = useRequest({
  resource: 'users',
  action: 'list',
});
```

### Plugin Development / 插件开发
- Extend the `Plugin` class for new plugins
- 扩展 `Plugin` 类创建新插件
- Register components, routes, and providers
- 注册组件、路由和提供者

```typescript
// Example / 示例
import { Plugin } from '@tachybase/client';

export class MyPlugin extends Plugin {
  async load() {
    this.app.addComponents({
      MyComponent,
    });
    this.app.addRoutes({
      path: '/my-route',
      element: <MyPage />,
    });
  }
}
```

### Data Source / 数据源
- Use `DataSourceManager` for data operations
- 使用 `DataSourceManager` 进行数据操作
- Use collection templates for common patterns
- 使用集合模板处理常见模式

```typescript
// Example / 示例
import { useCollection } from '@tachybase/client';

const { collection } = useCollection('users');
const records = await collection.list();
```

## File Organization / 文件组织

### Directory Structure / 目录结构
```
packages/client/src/
├── api-client/          # API client and hooks
├── application/         # Application core
├── schema-component/    # Schema components
├── data-source/        # Data source management
├── hooks/              # Shared hooks
└── ...
```

### Import Patterns / 导入模式
- Import from package root: `import { X } from '@tachybase/client'`
- 从包根目录导入：`import { X } from '@tachybase/client'`
- Avoid deep imports when possible
- 尽可能避免深度导入

```typescript
// Good / 好的
import { Application, useAPIClient } from '@tachybase/client';

// Avoid / 避免
import { Application } from '@tachybase/client/src/application';
```

## Testing / 测试

- Use `@tachybase/test` utilities for testing
- 使用 `@tachybase/test` 工具进行测试
- Test components with schema providers
- 使用 schema 提供者测试组件

```typescript
// Example / 示例
import { render } from '@tachybase/test';
import { SchemaComponentProvider } from '@tachybase/client';

test('MyComponent', () => {
  render(
    <SchemaComponentProvider>
      <MyComponent />
    </SchemaComponentProvider>
  );
});
```

## Best Practices / 最佳实践

1. **Type Safety / 类型安全**: Always use TypeScript types from the package
   始终使用包中的 TypeScript 类型
2. **Component Composition / 组件组合**: Prefer composition over inheritance
   优先使用组合而非继承
3. **Schema First / Schema 优先**: Use schema components when possible
   尽可能使用 schema 组件
4. **Plugin Architecture / 插件架构**: Extend functionality via plugins
   通过插件扩展功能

