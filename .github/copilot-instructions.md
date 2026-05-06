# Tego Framework - AI Coding Instructions

> **For detailed rules, see `.cursor/rules/` directory** / 详细规则请参见 `.cursor/rules/` 目录

## Project Overview / 项目概述

Tego (Tachybase) is a pluggable enterprise low-code application framework using pnpm monorepo. Core packages are in `packages/`, application entry points are in `apps/web` and `apps/desktop`.

Tego (Tachybase) 是一个基于插件的企业级低代码应用框架，采用 pnpm monorepo 结构。核心包位于 `packages/`，应用入口在 `apps/web` 和 `apps/desktop`。

## Tech Stack / 技术栈

- **Language / 语言**: TypeScript (5.8.3+)
- **Frontend Framework / 前端框架**: React 18.3.1
- **UI Library / UI 库**: Ant Design 5.22.5, Ant Design Pro Components
- **Package Manager / 包管理**: pnpm 10.x
- **Build Tools / 构建工具**: tegod CLI, Rsbuild
- **Linting / 代码检查**: oxlint, Prettier
- **Testing / 测试**: Vitest, Playwright
- **Node.js**: >= 20.19.0
- **Current Version / 当前版本**: 1.6.x

## Project Structure / 项目结构

```
tego-standard/
├── apps/                    # Applications / 应用目录
│   ├── web/                 # Web application / Web 应用
│   └── desktop/             # Desktop application / 桌面应用
├── packages/                # Packages / 包目录
│   ├── client/             # Core client library (@tachybase/client) / 核心客户端库
│   ├── module-*/           # Feature modules (auth, workflow, acl, collection, etc.) / 功能模块
│   └── plugin-*/           # Plugin packages / 插件包
├── scripts/                 # Build and utility scripts / 构建和工具脚本
└── docker/                  # Docker configuration / Docker 配置
```

## Package Naming Conventions / 包命名约定

- **`module-*`**: Core feature modules (auth, workflow, acl, collection, etc.) / 核心功能模块
- **`plugin-*`**: Pluggable extensions that depend on modules / 可插拔扩展插件
- **`plugin-adapter-*`**: Adapters (e.g., bullmq, redis) / 适配器
- **`plugin-field-*`**: Field plugins (e.g., formula, sequence) / 字段插件
- **`plugin-block-*`**: Block plugins (e.g., kanban, gantt, calendar) / 区块插件
- **`plugin-auth-*`**: Authentication plugins (e.g., oidc, saml, sms) / 认证插件
- **`plugin-action-*`**: Action plugins (e.g., import, export, print) / 动作插件
- **`@tachybase/client`**: Frontend core library / 前端核心库
- **`@tego/server`**: Backend runtime / 后端运行时

## Module/Plugin Development Pattern / 模块/插件开发模式

Each plugin/module follows **client/server separation structure**:
每个 plugin/module 遵循 **client/server 分离结构**:

```
packages/plugin-xxx/
├── src/
│   ├── client/         # Frontend code / 前端代码
│   │   └── Plugin.tsx  # extends Plugin from @tachybase/client
│   ├── server/         # Backend code / 后端代码
│   │   └── plugin.ts   # extends Plugin from @tego/server
│   ├── locale/         # i18n translations / 国际化翻译
│   │   ├── en-US.json
│   │   ├── zh-CN.json
│   │   └── ...other locales
│   └── index.ts        # Unified exports / 统一导出
├── client.js           # Entry re-export
└── server.js           # Entry re-export
```

## Dependency Injection Pattern / 依赖注入模式

Server-side uses `@InjectedPlugin` decorator to register Controllers and Services:
服务端使用 `@InjectedPlugin` 装饰器注册 Controllers 和 Services:

```typescript
import { InjectedPlugin, Plugin } from '@tego/server';

@InjectedPlugin({
  Controllers: [MyController],
  Services: [MyService],
})
export class MyPlugin extends Plugin {
  async load() {
    // Register actions, ACL, etc.
  }
}
```

## Plugin Lifecycle / 插件生命周期

### Client Plugin / 客户端插件
```typescript
import { Plugin } from '@tachybase/client';

export class MyPlugin extends Plugin {
  async afterAdd() { }    // Add sub-plugins: this.pm.add() / 添加子插件
  async load() { }        // Register components, routes, settings / 注册组件、路由、设置项
}
```

### Server Plugin / 服务端插件
```typescript
import { Plugin } from '@tego/server';

export class MyPlugin extends Plugin {
  afterAdd() { }          // Subscribe to events / 订阅事件
  beforeLoad() { }        // Register models, middleware / 注册模型、中间件
  async load() { }        // Register actions, ACL / 注册 actions、ACL
  async install() { }     // First installation / 首次安装
}
```

### Feature Pattern / Feature 模式
Use `addFeature` to compose multiple internal plugins in a module:
使用 `addFeature` 在 module 中组合多个内部 plugin:

```typescript
constructor(app, options) {
  super(app, options);
  this.addFeature(PluginSql);
  this.addFeature(PluginRequest);
}
```

## Development Commands / 开发命令

```bash
# Development / 开发
pnpm dev              # Start development server / 启动开发服务器
pnpm dev-local        # Start with .env.local / 使用本地环境变量启动
pnpm dev-server       # Start server only / 仅启动服务器

# Build / 构建
pnpm build            # Build all packages / 构建所有包
pnpm build:p          # Production build (skip .d.ts) / 快速构建（无 .d.ts）

# Code Quality / 代码质量
pnpm lint             # Run oxlint check / 运行 oxlint 检查
pnpm test             # Run all tests / 运行所有测试
pnpm tc               # Run client tests / 运行客户端测试
pnpm ts               # Run server tests / 运行服务端测试
pnpm e2e              # Run E2E tests (Playwright) / E2E 测试

# Package Management / 包管理
pnpm install          # Install dependencies / 安装依赖
pnpm tgi              # tego install
pnpm tgu              # tego upgrade
```

## Code Conventions / 代码规范

### Import Order / 导入顺序
Uses `@ianvs/prettier-plugin-sort-imports` for auto-sorting: external libs → internal `@tachybase/*` → relative paths
使用 `@ianvs/prettier-plugin-sort-imports` 自动排序

### Catalog Version Management / Catalog 版本管理
`pnpm-workspace.yaml` uses `catalog:` for unified version management:
```json
"dependencies": {
  "@tachybase/test": "catalog:",
  "react": "catalog:"
}
```

### Code Style / 代码风格
- **Indentation / 缩进**: 2 spaces / 2 空格
- **Quotes / 引号**: Single quotes / 单引号
- **Semicolons / 分号**: No semicolons / 不使用分号
- **Line Length / 行长度**: Max 100 characters / 最大 100 字符

### Naming Conventions / 命名约定
- **Files / 文件**: kebab-case (`user-service.ts`)
- **Classes / 类**: PascalCase (`UserService`)
- **Functions/Variables / 函数/变量**: camelCase (`getUserById`)
- **Constants / 常量**: UPPER_SNAKE_CASE (`MAX_RETRY_COUNT`)

### Git Commit / Git 提交
- Format / 格式: `type(scope): message`
- Types / 类型: feat, fix, docs, style, refactor, test, chore

## Internationalization / 国际化

**⚠️ CRITICAL: All user-facing text must support both English and Chinese / 所有面向用户的文本必须支持英文和中文**

### Supported Languages / 支持的语言
en-US, zh-CN, ko_KR, ja-JP, pt-BR, fr-FR, es-ES, ru-RU, tr-TR, uk_UA, zh-TW

### i18n Checklist / 国际化检查清单
1. Use `useTranslation()` hook for all UI text / 所有界面文本使用 `useTranslation()` hook
2. Add translation keys to ALL locale files (not just zh-CN and en-US) / 在所有语言文件中添加翻译键
3. Provide `displayName` and `displayName.zh-CN` for plugin registration / 插件注册时提供双语显示名

```typescript
const { t } = useTranslation();
<Button>{t('Save')}</Button>  // Will display "保存" in Chinese mode
```

## Database & ORM / 数据库与 ORM

Based on Sequelize, supports SQLite / PostgreSQL / MySQL. Collection definitions in `collections/` directory.
基于 Sequelize，支持 SQLite / PostgreSQL / MySQL。Collection 定义在 `collections/` 目录。

### Collection Definition / 集合定义
```typescript
this.app.db.defineCollection({
  name: 'users',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'email', type: 'string', unique: true },
  ],
});
```

## Testing / 测试

- **Vitest**: `vitest.config.mts` (uses `@tachybase/test`)
- **E2E**: `playwright.config.ts`
- Test files in `__tests__/` or `__e2e__/` directories

## Related Rules / 相关规则

For detailed development guidelines, see the `.cursor/rules/` directory:
详细开发指南请参见 `.cursor/rules/` 目录:

- `core/project.md` - Project configuration / 项目配置
- `core/ai-assistant.md` - AI development guidelines / AI 开发指南
- `code-style/*.md` - Code style rules / 代码风格规则
- `frontend/*.md` - Frontend development / 前端开发
- `backend/*.md` - Backend development / 后端开发
- `reference/*.md` - Reference documents / 参考文档
