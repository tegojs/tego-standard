# Tego Standard Project Context / Tego Standard 项目上下文文档

> Records important project decisions, architectural patterns, and context information  
> 记录项目的重要决策、架构模式和上下文信息

## Project Overview / 项目概述

**Project Name / 项目名称**：Tego Standard (Tachybase)  
**Type / 类型**：TypeScript Monorepo - Standard Application / 标准应用  
**Package Manager / 包管理**：pnpm workspace  
**Last Updated / 最后更新**：2025-01-27

---

## Project Structure / 项目结构

### Directory Structure / 目录结构

```
tego-standard/
├── packages/                    # Application packages / 应用包
│   ├── client/                 # Core client library (@tachybase/client) / 核心客户端库
│   ├── module-*/              # Feature modules / 功能模块
│   │   ├── module-acl/        # ACL module / 权限控制模块
│   │   ├── module-auth/       # Authentication module / 认证模块
│   │   ├── module-user/       # User module / 用户模块
│   │   ├── module-workflow/   # Workflow module / 工作流模块
│   │   └── ...
│   └── plugin-*/              # Plugins / 插件
│       ├── plugin-workflow-approval/  # Workflow approval plugin / 审批插件
│       ├── plugin-theme-editor/       # Theme editor plugin / 主题编辑器插件
│       └── ...
└── apps/
    └── web/                    # Web application / Web 应用
```

### Main Packages / 主要包

- **client** (`@tachybase/client`)：Core client library, provides application framework and plugin system / 核心客户端库，提供应用框架和插件系统
- **module-***：Feature modules, provide core business functionality / 功能模块，提供核心业务功能
  - `module-acl`：Access control / 权限控制
  - `module-auth`：Authentication and authorization / 认证授权
  - `module-user`：User management / 用户管理
  - `module-workflow`：Workflow engine / 工作流引擎
  - `module-collection`：Collection management / 集合管理
  - `module-data-source`：Data source management / 数据源管理
- **plugin-***：Plugins, extend application functionality / 插件，扩展应用功能
  - `plugin-workflow-approval`：Workflow approval / 工作流审批
  - `plugin-theme-editor`：Theme editor / 主题编辑器
  - `plugin-form-design`：Form designer / 表单设计器
  - And more... / 等等...

---

## Tech Stack / 技术栈

### Backend / 后端
- **Runtime / 运行时**：Node.js (>=20.19.0)
- **Framework / 框架**：Based on Tego core framework / 基于 Tego 核心框架
- **Database / 数据库**：Prisma ORM
- **Language / 语言**：TypeScript

### Frontend / 前端
- **Framework / 框架**：React 18
- **Language / 语言**：TypeScript
- **UI Library / UI 库**：Ant Design
- **State Management / 状态管理**：Based on React Hooks / 基于 React Hooks
- **Build Tool / 构建工具**：tachybase (based on tsup/vite) / tachybase (基于 tsup/vite)

### Toolchain / 工具链
- **Package Manager / 包管理**：pnpm workspace
- **Testing / 测试**：Vitest
- **E2E / 端到端测试**：Playwright
- **Code Quality / 代码质量**：oxlint, Prettier
- **CLI Tool / CLI 工具**：tachybase CLI

### Internationalization / 国际化
- **Framework / 框架**：i18next
- **Supported Languages / 支持语言**：en-US, zh-CN, ko_KR, ja-JP, pt-BR, fr-FR, es-ES, ru-RU, tr-TR, uk_UA, zh-TW
- **Translation File Location / 翻译文件位置**：`packages/*/src/locale/` directory / 目录
- **File Format / 文件格式**：`.ts` or `.json` / `.ts` 或 `.json`
- **Mandatory Rule / 必须规则**：When adding or modifying translations, must synchronize all language files / 添加或修改翻译时，必须同步更新所有语言文件

---

## Key Decision Records / 关键决策记录

### 2025-01-27: Establish Cursor AI Rules System / 建立 Cursor AI 规则系统
- **Decision / 决策**：Adopt modular skill rules system / 采用模块化的技能规则系统
- **Reason / 原因**：Improve consistency and efficiency of AI-assisted programming / 提高 AI 辅助编程的一致性和效率
- **Impact / 影响**：All development work should follow rules in `.cursor/rules/` / 所有开发工作都应遵循 `.cursor/rules/` 中的规则

### Architecture Decisions / 架构决策
- **Monorepo Structure / Monorepo 结构**：Use pnpm workspace to manage multiple packages / 使用 pnpm workspace 管理多个包
- **Modular Design / 模块化设计**：Separate feature modules (module-*) and plugins (plugin-*) / 功能模块（module-*）和插件（plugin-*）分离
- **Type Safety / 类型安全**：Strictly use TypeScript, avoid any / 严格使用 TypeScript，避免 any
- **Code Organization / 代码组织**：Organize by feature modules, not by technical layers / 按功能模块组织，而非按技术层次
- **Client Architecture / 客户端架构**：Application framework and plugin system based on `@tachybase/client` / 基于 `@tachybase/client` 的应用框架和插件系统

### Package Naming Conventions / 包命名规范
- **Modules / 模块**：`module-*` (e.g., `module-auth`) / `module-*`（如 `module-auth`）
- **Plugins / 插件**：`plugin-*` (e.g., `plugin-workflow-approval`) / `plugin-*`（如 `plugin-workflow-approval`）
- **Adapters / 适配器**：`plugin-adapter-*` (e.g., `plugin-adapter-bullmq`) / `plugin-adapter-*`（如 `plugin-adapter-bullmq`）
- **Field Plugins / 字段插件**：`plugin-field-*` (e.g., `plugin-field-formula`) / `plugin-field-*`（如 `plugin-field-formula`）
- **Block Plugins / 区块插件**：`plugin-block-*` (e.g., `plugin-block-kanban`) / `plugin-block-*`（如 `plugin-block-kanban`）

---

## Development Standards / 开发规范

### Code Style / 代码风格
- **Indentation / 缩进**：2 spaces / 2 空格
- **Quotes / 引号**：Single quotes (for strings) / 单引号（字符串）
- **Semicolons / 分号**：No semicolons / 不使用分号
- **Line Length / 行长度**：Maximum 100 characters / 最大 100 字符

### Naming Conventions / 命名约定
- **Files / 文件**：kebab-case (`user-service.ts`)
- **Classes / 类**：PascalCase (`UserService`)
- **Functions/Variables / 函数/变量**：camelCase (`getUserById`)
- **Constants / 常量**：UPPER_SNAKE_CASE (`MAX_RETRY_COUNT`)

### Git Commit Convention / Git 提交规范
- Use commitlint / 使用 commitlint
- Format / 格式：`type(scope): message`
- Types / 类型：feat, fix, docs, style, refactor, test, chore
- Scope / 范围：Package name or module name (e.g., `module-auth`, `plugin-workflow-approval`) / 包名或模块名（如 `module-auth`, `plugin-workflow-approval`）

### Module/Plugin Development Standards / 模块/插件开发规范
- **Modules / 模块**：Provide core business functionality, usually include both server and client code / 提供核心业务功能，通常包含服务端和客户端代码
- **Plugins / 插件**：Extend application functionality, can depend on modules / 扩展应用功能，可以依赖模块
- **Import Standards / 导入规范**：Use `@tachybase/client` as client entry point / 使用 `@tachybase/client` 作为客户端入口
- **Server Side / 服务端**：Use `@tego/core` and `@tachybase/database` / 使用 `@tego/core` 和 `@tachybase/database`

---

## Common Commands / 常用命令

### Development / 开发
```bash
pnpm dev              # Start development server / 启动开发服务器
pnpm dev-local        # Start with local env vars / 使用本地环境变量启动
pnpm dev-server       # Start server only / 仅启动服务器
pnpm start            # Start production server / 启动生产服务器
```

### Build / 构建
```bash
pnpm build            # Build all packages / 构建所有包
pnpm build:p          # Production build (skip type declarations) / 生产构建（跳过类型声明）
pnpm clean            # Clean build artifacts / 清理构建产物
```

### Code Quality / 代码质量
```bash
pnpm lint             # Run oxlint check / 运行 oxlint 检查
pnpm test             # Run all tests / 运行所有测试
pnpm test:client      # Run client tests / 运行客户端测试
pnpm test:server      # Run server tests / 运行服务端测试
```

### Package Management / 包管理
```bash
pnpm install          # Install dependencies / 安装依赖
pnpm tbi              # tachybase install
pnpm tbu              # tachybase upgrade
```

---

## Current Tasks / 当前任务

### In Progress / 进行中
- [ ] Improve Cursor AI rules system / 完善 Cursor AI 规则系统
- [ ] Optimize module and plugin development experience / 优化模块和插件开发体验

### Planned / 计划中
- [ ] Add more skill rules / 添加更多技能规则
- [ ] Optimize skill activation mechanism / 优化技能激活机制
- [ ] Improve project documentation / 完善项目文档

---

## FAQ / 常见问题

### Q: How to create a new module? / 如何创建新的模块？
A: Use `tachybase` CLI to create module template, or refer to existing module structure. / 使用 `tachybase` CLI 创建模块模板，或参考现有模块结构。

### Q: How to create a new plugin? / 如何创建新的插件？
A: Use `tachybase` CLI to create plugin template, or refer to existing plugin structure. / 使用 `tachybase` CLI 创建插件模板，或参考现有插件结构。

### Q: What if skills don't activate automatically? / 技能没有自动激活怎么办？
A: Check if path patterns and keywords in `.cursor/skill-rules.json` match current context. / 检查 `.cursor/skill-rules.json` 中的路径模式和关键词是否匹配当前上下文。

### Q: What's the difference between modules and plugins? / 模块和插件有什么区别？
A: Modules provide core business functionality, plugins extend application functionality. Plugins can depend on modules. / 模块提供核心业务功能，插件扩展应用功能。插件可以依赖模块。

---

## Related Resources / 相关资源

- [Project README](../README.md)
- [Skill Rules Configuration](../skill-rules.json)
- [Cursor Rules Index](../rules/index.md)
- [Tego Official Documentation](https://tachybase.org/)

---

## Changelog / 更新日志

### 2025-01-27
- Create project context document / 创建项目上下文文档
- Establish Cursor AI rules system / 建立 Cursor AI 规则系统
- Add skill activation rules configuration / 添加技能激活规则配置
