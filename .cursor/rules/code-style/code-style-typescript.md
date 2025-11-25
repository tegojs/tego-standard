---
description: TypeScript code style guidelines - types, interfaces, type inference (Core type safety)
globs:
  - packages/**/*.ts
  - packages/**/*.tsx
  - apps/**/*.ts
  - apps/**/*.tsx
alwaysApply: true
---

# TypeScript Code Style / TypeScript 代码风格

- Use TypeScript strict mode (but project config has `strict: false`, note compatibility).
- 使用 TypeScript 严格模式（但项目配置中 `strict: false`，注意兼容性）
- Prefer type inference, explicitly declare types when necessary.
- 优先使用类型推断，必要时显式声明类型
- Use interfaces (interface) to define object types.
- 使用接口（interface）定义对象类型
- Use type aliases (type) for union types and complex types.
- 使用类型别名（type）定义联合类型和复杂类型
- Avoid using `any`, prefer `unknown` or specific types.
- 避免使用 `any`，优先使用 `unknown` 或具体类型

## Examples / 示例

```typescript
// Good: Use interface for object types / 好的：使用接口定义对象类型
interface User {
  id: number
  name: string
  email: string
}

// Good: Use type for union types / 好的：使用类型别名定义联合类型
type Status = 'pending' | 'approved' | 'rejected'

// Good: Prefer type inference / 好的：优先使用类型推断
const users = ['alice', 'bob'] // string[]

// Good: Use unknown instead of any / 好的：使用 unknown 而非 any
function processData(data: unknown) {
  if (typeof data === 'string') {
    return data.toUpperCase()
  }
  return null
}

// Avoid / 避免
function badExample(data: any) {
  return data.something // No type safety / 没有类型安全
}
```
