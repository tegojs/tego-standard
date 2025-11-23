---
description: File naming conventions and import order guidelines
globs:
  - packages/**/*.ts
  - packages/**/*.tsx
  - apps/**/*.ts
  - apps/**/*.tsx
alwaysApply: true
---

# File Naming & Import Order / 文件命名和导入顺序

## File Naming / 文件命名

- Component files: PascalCase (e.g., `UserProfile.tsx`)
- 组件文件: PascalCase (如 `UserProfile.tsx`)
- Utility files: camelCase (e.g., `formatDate.ts`)
- 工具文件: camelCase (如 `formatDate.ts`)
- Constant files: UPPER_SNAKE_CASE (e.g., `API_CONSTANTS.ts`)
- 常量文件: UPPER_SNAKE_CASE (如 `API_CONSTANTS.ts`)
- Type definitions: PascalCase (e.g., `UserTypes.ts`)
- 类型定义: PascalCase (如 `UserTypes.ts`)

## Import Order / 导入顺序

1. React-related imports / React 相关导入
2. Third-party library imports / 第三方库导入
3. Internal project imports (sorted by path hierarchy) / 项目内部导入（按路径层级排序）
4. Type imports (use `import type`) / 类型导入（使用 `import type`）

## Example / 示例

```typescript
// 1. React imports / React 导入
import React, { useState, useEffect } from 'react'

// 2. Third-party imports / 第三方库导入
import { Button } from 'antd'
import { useRequest } from 'ahooks'

// 3. Internal project imports / 项目内部导入
import { useAPIClient } from '@tachybase/client'
import { UserService } from '../services/UserService'

// 4. Type imports / 类型导入
import type { User } from '../types'
```
