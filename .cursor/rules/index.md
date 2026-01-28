# Tego/Tachybase Cursor Rules Index / 项目 Cursor 规则索引

This is the main rule configuration file for the Tego/Tachybase project, used to centrally manage and reference all project rules.

这是 Tego/Tachybase 项目的主规则配置文件，用于统一管理和引用所有项目规则。

## Language Support / 语言支持

**This project supports bilingual documentation (English and Chinese) for international collaboration.**

**本项目支持双语文档（英语和中文），便于国际协作。**

All rule files contain both English and Chinese content side by side for easy understanding by team members from different regions.

所有规则文件都包含并排的英文和中文内容，方便来自不同地区的团队成员理解。

## Rule File Structure / 规则文件结构

This project uses a modular rule file structure organized into folders, with each file focusing on a specific topic:

本项目使用模块化的规则文件结构，按文件夹组织，每个文件专注于特定的主题：

### Directory Organization / 目录组织

```
.cursor/rules/
├── core/                    # Core rules (always applied) / 核心规则（始终应用）
│   ├── project.md          # Project configuration / 项目配置
│   ├── lint-check.md       # Lint error checking / Lint 错误检查
│   └── ai-assistant.md      # AI development guidelines / AI 开发指南
├── code-style/              # Code style rules / 代码风格规则
│   ├── typescript.md        # TypeScript style / TypeScript 风格
│   ├── react.md            # React component style / React 组件风格
│   ├── naming.md           # Naming conventions / 命名规范
│   ├── formatting.md       # Code formatting / 代码格式化
│   └── refactoring.md      # Refactoring principles / 重构原则
├── development/            # Development guidelines / 开发指南
│   ├── workflow.md         # Development workflow / 开发工作流
│   ├── i18n.md            # Internationalization / 国际化
│   ├── debugging.md        # Debugging guidelines / 调试指南
│   ├── commits.md         # Commit conventions / 提交规范
│   ├── commands.md        # Common commands / 常用命令
│   └── refactoring.md      # Code extraction / 代码提取
├── frontend/               # Frontend rules / 前端规则
│   ├── guidelines.md       # Frontend guidelines / 前端指南
│   ├── components.md       # Component patterns / 组件模式
│   ├── state.md           # State management / 状态管理
│   ├── performance.md     # Performance optimization / 性能优化
│   ├── typescript.md       # TypeScript best practices / TypeScript 最佳实践
│   ├── i18n.md            # Frontend i18n / 前端国际化
│   └── best-practices.md  # Frontend best practices / 前端最佳实践
├── backend/               # Backend rules / 后端规则
│   ├── guidelines.md       # Backend guidelines / 后端指南
│   ├── architecture.md     # Architecture patterns / 架构模式
│   ├── patterns.md         # Design patterns / 设计模式
│   ├── error-handling.md   # Error handling / 错误处理
│   └── best-practices.md  # Backend best practices / 后端最佳实践
├── packages/              # Package-specific rules / 包特定规则
│   └── client.md          # Client package rules / Client 包规则
├── reference/             # Reference documents / 参考文档
│   ├── database-patterns.md  # Database patterns / 数据库模式
│   ├── performance.md        # Performance guide / 性能指南
│   ├── security.md          # Security guide / 安全指南
│   ├── testing.md           # Testing guide / 测试指南
│   └── quick-reference.md   # Quick reference / 快速参考
└── resources/             # Resource files / 资源文件
    ├── performance/       # Performance resources / 性能资源
    ├── security/         # Security resources / 安全资源
    └── testing/          # Testing resources / 测试资源
```

### Core Rules / 核心规则

- **Core / 核心** (`core/`) - Project configuration, lint checking, AI assistant guidelines
  项目配置、Lint 检查、AI 辅助指南

### Code Style / 代码风格

- **Code Style / 代码风格** (`code-style/`) - TypeScript, React, naming, formatting, refactoring
  TypeScript、React、命名、格式化、重构等代码规范

### Development / 开发

- **Development / 开发** (`development/`) - Workflow, i18n, debugging, commits, commands, refactoring
  开发流程、国际化、调试、提交、命令、重构

### Frontend / 前端

- **Frontend / 前端** (`frontend/`) - Components, state, performance, TypeScript, i18n, best practices
  组件、状态、性能、TypeScript、国际化、最佳实践

### Backend / 后端

- **Backend / 后端** (`backend/`) - Architecture, patterns, error handling, best practices
  架构、模式、错误处理、最佳实践

### Reference / 参考

- **Reference / 参考** (`reference/`) - Database patterns, performance, security, testing, quick reference
  数据库模式、性能、安全、测试、快速参考

## Reference All Rules / 引用所有规则

The following rule files will be automatically loaded and applied:

以下规则文件会被自动加载和应用：

### Core Rules / 核心规则

@file core/project.md
@file core/lint-check.md
@file core/ai-assistant.md

### Code Style / 代码风格

@file code-style/code-style-typescript.md
@file code-style/code-style-react.md
@file code-style/code-style-naming.md
@file code-style/code-style-formatting.md
@file code-style/code-style-refactoring.md

### Development / 开发

@file development/development-workflow.md
@file development/development-i18n.md
@file development/development-debugging.md
@file development/development-commits.md
@file development/development-commands.md
@file development/development-refactoring.md

### Frontend / 前端

@file frontend/frontend-guidelines.md
@file frontend/frontend-components.md
@file frontend/frontend-state.md
@file frontend/frontend-performance.md
@file frontend/frontend-typescript.md
@file frontend/frontend-i18n.md
@file frontend/frontend-best-practices.md

### Backend / 后端

@file backend/backend-guidelines.md
@file backend/backend-architecture.md
@file backend/backend-patterns.md
@file backend/backend-error-handling.md
@file backend/backend-best-practices.md

### Packages / 包

@file packages/packages-client.md

### Reference / 参考

@file reference/database-patterns.md
@file reference/performance.md
@file reference/security.md
@file reference/testing.md
@file reference/quick-reference.md

## Usage Instructions / 使用说明

1. **Auto-loading / 自动加载**: Cursor automatically reads all `.md` files in the `.cursor/rules/` directory.
   Cursor 会自动读取 `.cursor/rules/` 目录下的所有 `.md` 文件
2. **Priority / 优先级**: `index.md` serves as the main entry point, referencing other rules via `@file` syntax.
   `index.md` 作为主入口，通过 `@file` 语法引用其他规则
3. **Update Rules / 更新规则**: After modifying corresponding rule files, Cursor will automatically apply the new rules.
   修改对应的规则文件后，Cursor 会自动应用新的规则

## Configuration Version / 配置版本

- **Created / 创建时间**: 2024-11-10
- **Last Updated / 最后更新**: 2026-01-05
- **Cursor Version / Cursor 版本**: Supports `.cursor/rules/` directory structure with frontmatter and organized folders
  支持带 frontmatter 和文件夹组织的 `.cursor/rules/` 目录结构
- **Project Version / 项目版本**: 1.6.x
- **Configuration Version / 配置版本**: 2.1.0 (with folder organization)
  配置版本：2.1.0（带文件夹组织）

## Related Configuration / 相关配置

- **CLI Config / CLI 配置**: `.cursor/cli.json` - CLI permissions and command configuration
  CLI 权限和命令配置
- **Ignore File / 忽略文件**: `.cursorignore` - Files and directories ignored by AI indexing
  AI 索引忽略的文件和目录

