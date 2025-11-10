# Quick Reference / 快速参考

A quick reference guide for common development tasks and patterns.

常用开发任务和模式的快速参考指南。

## Common Commands / 常用命令

```bash
# Development / 开发
pnpm dev              # Start dev server / 启动开发服务器
pnpm dev-local        # Start with local env / 使用本地环境变量
pnpm build            # Build all packages / 构建所有包
pnpm lint             # Run linter / 运行代码检查
pnpm test             # Run tests / 运行测试

# Package Management / 包管理
pnpm install          # Install dependencies / 安装依赖
pnpm add <pkg> -w     # Add to root / 添加到根目录
pnpm add <pkg> --filter <name>  # Add to specific package / 添加到特定包
```

## Code Snippets / 代码片段

### React Component / React 组件

```typescript
import React from 'react'

interface Props {
  title: string
  onAction?: () => void
}

export const MyComponent: React.FC<Props> = ({ title, onAction }) => {
  return (
    <div>
      <h1>{title}</h1>
      {onAction && <button onClick={onAction}>Action</button>}
    </div>
  )
}
```

### API Request / API 请求

```typescript
import { useAPIClient, useRequest } from '@tachybase/client'

// Using useRequest / 使用 useRequest
const { data, loading, refresh } = useRequest({
  resource: 'users',
  action: 'list',
})

// Using APIClient directly / 直接使用 APIClient
const api = useAPIClient()
const response = await api.resource('users').list()
```

### Schema Component / Schema 组件

```typescript
import { SchemaComponent } from '@tachybase/client'

const schema = {
  type: 'void',
  'x-component': 'Card',
  properties: {
    title: {
      type: 'string',
      'x-component': 'Input',
      'x-component-props': {
        placeholder: 'Enter title',
      },
    },
  },
}

<SchemaComponent schema={schema} />
```

### Plugin Registration / 插件注册

```typescript
import { Plugin } from '@tachybase/client'

export class MyPlugin extends Plugin {
  async load() {
    this.app.addComponents({ MyComponent })
    this.app.addRoutes({
      path: '/my-route',
      element: <MyPage />,
    })
  }
}
```

## File Naming / 文件命名

| Type / 类型 | Pattern / 模式 | Example / 示例 |
|------------|---------------|---------------|
| Component / 组件 | PascalCase | `UserProfile.tsx` |
| Utility / 工具 | camelCase | `formatDate.ts` |
| Constant / 常量 | UPPER_SNAKE_CASE | `API_CONSTANTS.ts` |
| Type / 类型 | PascalCase | `UserTypes.ts` |

## Import Patterns / 导入模式

```typescript
// 1. React
import React, { useState } from 'react'

// 2. Third-party
import { Button } from 'antd'

// 3. Internal
import { useAPIClient } from '@tachybase/client'

// 4. Types
import type { User } from '../types'
```

## Commit Message Format / 提交信息格式

```
<type>(<scope>): <description>

Types / 类型:
  feat:     New feature / 新功能
  fix:      Bug fix / 修复
  docs:     Documentation / 文档
  style:    Formatting / 格式
  refactor: Code refactoring / 重构
  test:     Tests / 测试
  chore:    Maintenance / 维护

Examples / 示例:
  feat(client): add user profile
  fix(plugin-workflow): resolve approval issue
  docs: update README
```

## TypeScript Patterns / TypeScript 模式

```typescript
// Interface / 接口
interface User {
  id: number
  name: string
}

// Type alias / 类型别名
type Status = 'pending' | 'approved' | 'rejected'

// Generic function / 泛型函数
function process<T>(data: T): T {
  return data
}

// Type guard / 类型守卫
function isUser(obj: unknown): obj is User {
  return typeof obj === 'object' && obj !== null && 'id' in obj
}
```

## Testing Patterns / 测试模式

```typescript
import { render, screen } from '@tachybase/test'
import { SchemaComponentProvider } from '@tachybase/client'

test('renders component', () => {
  render(
    <SchemaComponentProvider>
      <MyComponent />
    </SchemaComponentProvider>
  )
  expect(screen.getByText('Hello')).toBeInTheDocument()
})
```

## Common Patterns / 常见模式

### Error Handling / 错误处理

```typescript
try {
  const result = await api.resource('users').create(data)
  return result
} catch (error) {
  console.error('Failed to create user:', error)
  throw error
}
```

### Loading States / 加载状态

```typescript
const { data, loading, error } = useRequest({
  resource: 'users',
  action: 'list',
})

if (loading) return <Spin />
if (error) return <Alert message={error.message} />
return <UserList data={data} />
```

## Resources / 资源

- **Project Docs / 项目文档**: https://tachybase.org/
- **GitHub**: https://github.com/tegojs/tego
- **Gitee**: https://gitee.com/tachybase/tachybase

