---
description: Project overview, tech stack, and package management configuration for Tego/Tachybase monorepo
globs:
  - package.json
  - pnpm-workspace.yaml
  - apps/**/package.json
  - packages/**/package.json
alwaysApply: true
---

# Tego/Tachybase Project Configuration / 项目配置

## Project Overview / 项目概述
Tego (Tachybase) is a pluggable application framework that enables developers to build complex application logic. This is a monorepo project managed with pnpm workspace.

Tego (Tachybase) 是一个插件化的应用框架，支持开发者构建复杂的应用逻辑。这是一个 monorepo 项目，使用 pnpm workspace 管理多个包。

## Tech Stack / 技术栈
- **Language / 语言**: TypeScript (5.8.3+)
- **Frontend Framework / 前端框架**: React 18.3.1
- **UI Library / UI 库**: Ant Design 5.22.5, Ant Design Pro Components
- **Package Manager / 包管理**: pnpm 10.13.1
- **Build Tools / 构建工具**: Tachybase CLI, Rsbuild
- **Linting / 代码检查**: oxlint, Prettier
- **Testing / 测试**: Vitest, Playwright
- **Node.js**: >= 20.19.0

## Project Structure / 项目结构
```
tego-standard/
├── apps/                    # Applications / 应用目录
│   └── web/                 # Web application / Web 应用
├── packages/                # Packages / 包目录
│   ├── client/             # Client core package / 客户端核心包
│   ├── module-*/           # Core modules (e.g., module-auth, module-collection) / 核心模块（如 module-auth, module-collection 等）
│   └── plugin-*/           # Plugin packages (e.g., plugin-workflow-approval) / 插件包（如 plugin-workflow-approval 等）
├── scripts/                 # Build and utility scripts / 构建和工具脚本
├── .github/workflows/       # GitHub Actions workflows / GitHub Actions 工作流
└── docker/                  # Docker configuration / Docker 配置
```

## Package Management / 包管理规范

### Version Number / 版本号
- Version numbers are managed uniformly, all packages use the same major version number.
- 主版本号统一管理，所有包使用相同的主版本号
- Current version: 1.4.5 (module-hera uses 2.4.5)
- 当前版本: 1.4.5（module-hera 使用 2.4.5）
- When modifying version numbers, synchronize updates across all related package.json files.
- 修改版本号时，需要同步更新所有相关包的 package.json

### Dependency Management / 依赖管理
- Use `workspace:*` to reference internal packages.
- 使用 `workspace:*` 引用内部包
- Use `pnpm` instead of `npm` or `yarn`.
- 使用 `pnpm` 而非 `npm` 或 `yarn`
- When adding dependencies, use `pnpm add <package> -w` (root directory) or `pnpm add <package> --filter <package-name>`.
- 添加依赖时使用 `pnpm add <package> -w`（根目录）或 `pnpm add <package> --filter <package-name>`

## Important Notes / 注意事项

### Workflow Files / 工作流文件
- GitHub Actions workflow files follow the current branch.
- GitHub Actions 工作流文件以当前分支为准
- When modifying workflows, check trigger conditions and permission settings.
- 修改工作流时注意检查触发条件和权限设置

### Version Conflicts / 版本冲突
- If version conflicts occur during merge, use the version from the main branch.
- 合并时如果出现版本号冲突，以 main 分支的版本号为准
- All package.json files must maintain consistent version numbers (except module-hera).
- 所有 package.json 文件的版本号需要保持一致（module-hera 除外）

### Path Aliases / 路径别名
- The project uses TypeScript path aliases, refer to `tsconfig.paths.json`.
- 项目使用 TypeScript 路径别名，参考 `tsconfig.paths.json`
- Use aliases instead of relative paths when importing.
- 导入时可以使用别名而非相对路径

### Internationalization / 国际化

**This project fully supports bilingual mode (English and Chinese) for international collaboration.**

**本项目完全支持双语模式（英文和中文），便于国际协作。**

#### Core Requirements / 核心要求

- **Language Support / 语言支持**: English (en-US) and Chinese Simplified (zh-CN)
- **语言支持**：英文（en-US）和简体中文（zh-CN）
- **Framework / 框架**: Uses i18next for internationalization
- **框架**：使用 i18next 进行国际化
- **Default Language / 默认语言**: English (en-US), with Chinese (zh-CN) as secondary
- **默认语言**：英文（en-US），中文（zh-CN）作为次要语言

#### Implementation Guidelines / 实现指南

1. **Plugin/Module Registration / 插件/模块注册**
   - Must provide both `displayName` (English) and `displayName.zh-CN` (Chinese) fields
   - 必须提供 `displayName`（英文）和 `displayName.zh-CN`（中文）字段
   - Example / 示例:
   ```typescript
   this.app.pluginManager.add('my-plugin', {
     name: 'my-plugin',
     displayName: 'My Plugin',
     displayName: {
       'zh-CN': '我的插件',
     },
   })
   ```

2. **UI Text / 界面文本**
   - Use i18next `t()` function for all user-facing text
   - 所有面向用户的文本使用 i18next 的 `t()` 函数
   - Define translation keys in locale files (both English and Chinese)
   - 在 locale 文件中定义翻译键（英文和中文）
   - Example / 示例:
   ```typescript
   const { t } = useTranslation();
   <Button>{t('Save')}</Button>  // Will display "保存" in Chinese mode
   ```

3. **Documentation Files / 文档文件**
   - README files: `README.md` (English) and `README.zh-CN.md` (Chinese)
   - README 文件：`README.md`（英文）和 `README.zh-CN.md`（中文）
   - Changelog files: `CHANGELOG.md` (English) and `CHANGELOG.zh-CN.md` (Chinese)
   - 更新日志文件：`CHANGELOG.md`（英文）和 `CHANGELOG.zh-CN.md`（中文）
   - Rule files: All `.cursor/rules/*.md` files contain bilingual content side by side
   - 规则文件：所有 `.cursor/rules/*.md` 文件都包含并排的双语内容

4. **Code Comments / 代码注释**
   - Important comments should be bilingual when possible
   - 重要注释应尽可能使用双语
   - Use format: `// English comment / 中文注释`
   - 使用格式：`// English comment / 中文注释`

5. **Error Messages / 错误信息**
   - All error messages must support both languages
   - 所有错误信息必须支持两种语言
   - Use i18next translation keys, not hardcoded strings
   - 使用 i18next 翻译键，不要硬编码字符串

#### Best Practices / 最佳实践

- **Always provide both languages** when adding new features
- **添加新功能时始终提供两种语言**
- **Test in both languages** to ensure UI layout works correctly
- **在两种语言下测试**，确保 UI 布局正确
- **Use translation keys** instead of hardcoded text
- **使用翻译键**而非硬编码文本
- **Keep translations synchronized** when updating content
- **更新内容时保持翻译同步**

### Plugin System / 插件系统
- Plugins must implement the Plugin interface.
- 插件需要实现 Plugin 接口
- Plugins can register routes, components, data sources, etc.
- 插件可以注册路由、组件、数据源等
- Use PluginManager to manage plugin lifecycle.
- 使用 PluginManager 管理插件生命周期

## Related Resources / 相关资源
- Project Documentation / 项目文档: https://tachybase.org/
- GitHub: https://github.com/tegojs/tego
- Gitee: https://gitee.com/tachybase/tachybase

