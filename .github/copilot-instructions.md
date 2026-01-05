# Tego Framework - AI Coding Instructions

## Project Overview
Tego 是一个基于插件的企业级低代码应用框架，采用 pnpm monorepo 结构。核心包位于 `packages/`，应用入口在 `apps/web` 和 `apps/desktop`。

## Architecture Pattern

### Package 命名约定
- **`module-*`**: 核心功能模块（auth, workflow, acl, collection 等），提供基础能力
- **`plugin-*`**: 可插拔扩展插件，依赖 module 扩展功能
- **`client`**: 前端核心库，基于 React + Ant Design
- **`@tego/server`**: 后端运行时，`@tego/client`: 前端运行时

### Plugin 开发模式
每个 plugin/module 遵循 **client/server 分离结构**:
```
packages/plugin-xxx/
├── src/
│   ├── client/         # 前端代码
│   │   └── Plugin.tsx  # 继承 Plugin from @tachybase/client
│   ├── server/         # 后端代码
│   │   └── plugin.ts   # 继承 Plugin from @tego/server
│   ├── locale/         # i18n 翻译
│   └── index.ts        # 统一导出
├── client.js           # 入口 re-export
└── server.js           # 入口 re-export
```

### 依赖注入模式
服务端使用 `@InjectedPlugin` 装饰器注册 Controllers 和 Services:
```typescript
import { InjectedPlugin, Plugin } from '@tego/server';

@InjectedPlugin({
  Controllers: [MyController],
  Services: [MyService],
})
export class MyPlugin extends Plugin { }
```

### Workflow 扩展模式
工作流通过 Registry 模式注册 Triggers 和 Instructions:
```typescript
// 服务端 - 在 beforeLoad 或 afterLoadPlugin 中注册
plugin.triggers.register('my-trigger', new MyTrigger(plugin));
plugin.instructions.register('my-instruction', new MyInstruction(plugin));

// 客户端 - 使用 registerTrigger/registerInstruction
pluginWorkflow.registerTrigger('my-trigger', MyTriggerComponent);
pluginWorkflow.registerInstruction('my-instruction', MyInstructionComponent);
```

## Development Commands

```bash
# 开发模式
pnpm dev                           # 启动开发服务器
pnpm dev-local                     # 使用 .env.local 配置启动

# 构建
pnpm build                         # 完整构建
pnpm build:p                       # 快速构建（无 .d.ts）
pnpm tegod build --include @tachybase/module-xxx  # 单包构建

# 测试
pnpm test                          # 运行所有测试
pnpm test:client / pnpm tc         # 客户端测试
pnpm test:server / pnpm ts         # 服务端测试
pnpm e2e                           # E2E 测试 (Playwright)

# 启动生产服务
npx tego start --quickstart        # 快速启动（SQLite）
```

## Code Conventions

### 导入顺序
使用 `@ianvs/prettier-plugin-sort-imports` 自动排序，外部库 → 内部 `@tachybase/*` → 相对路径

### Catalog 版本管理
`pnpm-workspace.yaml` 中的 `catalog:` 管理统一版本，新增依赖使用 `catalog:` 引用:
```json
"dependencies": {
  "@tachybase/client": "catalog:",
  "react": "catalog:"
}
```

### Linting
- 使用 `oxlint` 进行快速 lint
- Commit 使用 Conventional Commits 规范

## Key Integration Points

### Client Plugin 生命周期
```typescript
class MyPlugin extends Plugin {
  async afterAdd() { }    // 添加子插件 this.pm.add()
  async load() { }        // 注册组件、路由、设置项
}
```

### Server Plugin 生命周期
```typescript
class MyPlugin extends Plugin {
  afterAdd() { }          // 订阅事件
  beforeLoad() { }        // 注册模型、中间件
  async load() { }        // 注册 actions、ACL
  async install() { }     // 首次安装
}
```

### 子插件/Feature 模式
使用 `addFeature` 在 module 中组合多个内部 plugin:
```typescript
constructor(app, options) {
  super(app, options);
  this.addFeature(PluginSql);
  this.addFeature(PluginRequest);
}
```

## Testing

- Vitest 配置: `vitest.config.mts` (使用 `@tachybase/test`)
- E2E 配置: `playwright.config.ts`
- 测试文件位于 `__tests__/` 或 `__e2e__/` 目录

## Database & ORM
基于 Sequelize，支持 SQLite / PostgreSQL / MySQL。Collection 定义在 `collections/` 目录。
