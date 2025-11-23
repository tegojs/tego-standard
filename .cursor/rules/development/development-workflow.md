---
description: Development workflow - creating modules/plugins, package structure
globs:
  - packages/**/*.ts
  - packages/**/*.tsx
alwaysApply: false
---

# Development Workflow / 开发工作流

## Creating New Modules/Plugins / 创建新模块/插件

1. Create a new directory under `packages/`.
2. Follow naming conventions: `module-*` or `plugin-*`.
3. Create `package.json` with correct `name`, `version`, and dependencies.
4. Add necessary TypeScript configuration.
5. Implement core functionality.

## Example: Creating a Plugin / 示例：创建插件

```typescript
// packages/plugin-my-feature/src/index.ts
import { Plugin } from '@tachybase/client'

export class MyFeaturePlugin extends Plugin {
  async load() {
    this.app.addComponents({ MyFeatureComponent })
    this.app.addRoutes({ path: '/my-feature', element: <MyFeaturePage /> })
  }
}
```
