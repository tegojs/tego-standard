---
description: React component code style - functional components, hooks, props
globs:
  - packages/**/*.tsx
  - apps/**/*.tsx
alwaysApply: false
---

# React Component Code Style / React 组件代码风格

- Use functional components and Hooks.
- 使用函数式组件和 Hooks
- Component files use PascalCase naming (e.g., `UserProfile.tsx`).
- 组件文件使用 PascalCase 命名（如 `UserProfile.tsx`）
- Use `React.FC` or direct function declarations.
- 使用 `React.FC` 或直接函数声明
- Define Props using interfaces.
- Props 使用接口定义
- Prefer named exports over default exports.
- 优先使用命名导出而非默认导出

## Examples / 示例

```typescript
// Good: Functional component with interface / 好的：使用接口的函数组件
interface UserProfileProps {
  userId: number
  onUpdate?: (user: User) => void
}

export const UserProfile: React.FC<UserProfileProps> = ({ userId, onUpdate }) => {
  const [user, setUser] = useState<User | null>(null)
  useEffect(() => {
    fetchUser(userId).then(setUser)
  }, [userId])
  return <div>{user?.name}</div>
}

// Good: Direct function declaration / 好的：直接函数声明
export function UserCard({ user }: { user: User }) {
  return <div>{user.name}</div>
}

// Avoid: Default export / 避免：默认导出
export default function UserProfile() { } // Not recommended / 不推荐
```
