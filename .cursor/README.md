# Cursor Configuration Documentation / Cursor 配置文档

This directory contains all Cursor AI configuration files for the Tego/Tachybase project.

此目录包含 Tego/Tachybase 项目的所有 Cursor AI 配置文件。

## Directory Structure / 目录结构

```
.cursor/
├── README.md              # This file / 本文件
├── cli.json               # CLI permissions configuration / CLI 权限配置
├── skill-rules.json      # Skill activation rules configuration / 技能激活规则配置
├── hooks.json            # Hooks configuration template / Hooks 配置模板
├── hooks/                # Hooks scripts directory / Hooks 脚本目录
│   ├── README.md        # Hooks setup instructions / Hooks 设置说明
│   └── format.sh        # Auto-format script / 自动格式化脚本
└── rules/                 # AI rules directory / AI 规则目录
    ├── index.md          # Main rule index (references all rules) / 主规则索引（引用所有规则）
    ├── project.md        # Project configuration / 项目配置
    ├── code-style.md     # Code style guidelines (with examples) / 代码风格规范（含示例）
    ├── development.md    # Development guide (with examples) / 开发指南（含示例）
    ├── ai-assistant.md   # AI assistant guide / AI 辅助指南
    ├── lint-check.md     # Lint checking rules / Lint 检查规则
    ├── testing.md        # Testing patterns and best practices / 测试模式和最佳实践
    ├── performance.md    # Performance optimization guidelines / 性能优化指南
    ├── security.md       # Security development guidelines / 安全开发指南
    ├── packages-client.md # Client package specific rules / Client 包特定规则
    ├── packages-tenant.md # Tenant isolation rules / 租户隔离规则
    └── quick-reference.md # Quick reference card / 快速参考卡片
```

## Files Overview / 文件概览

### `.cursorignore`
- **Location / 位置**: Project root / 项目根目录
- **Purpose / 用途**: Controls which files Cursor AI should ignore when indexing
  控制 Cursor AI 索引时应忽略的文件
- **Content / 内容**: Excludes node_modules, build artifacts, sensitive files, etc.
  排除 node_modules、构建产物、敏感文件等

### `.cursor/cli.json`
- **Purpose / 用途**: Defines CLI permissions for Cursor AI operations
  定义 Cursor AI 操作的 CLI 权限
- **Key Settings / 关键设置**:
  - Allows: git, pnpm, npm, node commands; reading/writing source files
    允许：git、pnpm、npm、node 命令；读写源代码文件
  - Denies: Dangerous commands (rm, format); sensitive files (.env, keys)
    禁止：危险命令（rm、format）；敏感文件（.env、keys）

### `.cursor/skill-rules.json`
- **Purpose / 用途**: Defines skill activation rules for automatic rule triggering
  定义技能激活规则，用于自动触发规则
- **Key Features / 关键特性**:
  - Auto-activation based on file paths, keywords, and code patterns
    基于文件路径、关键词和代码模式的自动激活
  - Priority levels (high/medium/low) for rule importance
    优先级级别（高/中/低）用于规则重要性
  - Supports backend, frontend, database, client, i18n, testing, performance, and security skills
    支持后端、前端、数据库、客户端、国际化、测试、性能和安全技能

### `.cursor/hooks.json` & `.cursor/hooks/`
- **Purpose / 用途**: Hooks configuration template for automatic code formatting and translation synchronization after file edits
  Hooks 配置模板，用于文件编辑后自动代码格式化和翻译同步
- **Key Features / 关键特性**:
  - **Auto-format / 自动格式化**: Auto-format code files after editing using Prettier
    使用 Prettier 在编辑后自动格式化代码文件
    - Supports JavaScript, TypeScript, JSON, SQL, and Markdown files
      支持 JavaScript、TypeScript、JSON、SQL 和 Markdown 文件
  - **Translation Sync Reminder / 翻译同步提醒**: Detects locale file edits and reminds AI to sync translation keys
    检测 locale 文件编辑并提醒 AI 同步翻译键
    - Supports JSON and TypeScript locale files
      支持 JSON 和 TypeScript 格式的 locale 文件
    - Hook only detects and reminds; actual sync is performed by AI according to rules
      Hook 只负责检测和提醒，实际同步由 AI 根据规则执行
    - See `.cursor/rules/lint-check.md` for sync rules
      查看 `.cursor/rules/lint-check.md` 了解同步规则
  - **Note / 注意**: Hooks must be copied to `~/.cursor/` directory to work
    Hooks 必须复制到 `~/.cursor/` 目录才能生效
  - See `.cursor/hooks/README.md` for setup instructions
    查看 `.cursor/hooks/README.md` 了解设置说明

### `.cursor/rules/`
- **Purpose / 用途**: Contains all AI behavior rules and guidelines
  包含所有 AI 行为规则和指南
- **Language / 语言**: Bilingual (English/Chinese) / 双语（英文/中文）
- **Files / 文件**:
  - `index.md`: Main entry point, references all other rules
    主入口点，引用所有其他规则
  - `project.md`: Project overview, tech stack, package management
    项目概述、技术栈、包管理
  - `code-style.md`: TypeScript, React, file naming conventions (with code examples)
    TypeScript、React、文件命名规范（含代码示例）
  - `development.md`: Workflow, commit conventions, commands (with code examples)
    工作流、提交规范、命令（含代码示例）
  - `ai-assistant.md`: AI-assisted development guidelines
    AI 辅助开发指南
  - `lint-check.md`: Mandatory lint error checking rules
    Lint 错误检查规则
  - `testing.md`: Testing patterns and best practices (Vitest/Playwright)
    测试模式和最佳实践（Vitest/Playwright）
  - `performance.md`: Performance optimization guidelines
    性能优化指南
  - `security.md`: Security development guidelines
    安全开发指南
  - `packages-client.md`: Specific rules for packages/client directory
    packages/client 目录的特定规则
  - `quick-reference.md`: Quick reference for common tasks and code patterns
    常用任务和代码模式的快速参考

## Best Practices / 最佳实践

### ✅ Current Implementation / 当前实现

1. **Modular Rules / 模块化规则**: Rules are split into focused files
   规则被拆分为专注的文件
2. **Bilingual Support / 双语支持**: All rules support English and Chinese
   所有规则支持英文和中文
3. **Main Index / 主索引**: `index.md` provides a clear entry point
   `index.md` 提供清晰的入口点
4. **Skill Activation / 技能激活**: Automatic rule triggering based on context
   基于上下文的自动规则触发
5. **Security / 安全性**: CLI permissions protect sensitive operations
   CLI 权限保护敏感操作
6. **Performance / 性能**: `.cursorignore` excludes unnecessary files
   `.cursorignore` 排除不必要的文件
7. **Comprehensive Coverage / 全面覆盖**: Rules cover testing, performance, and security
   规则涵盖测试、性能和安全

### 📋 Maintenance Guidelines / 维护指南

1. **Adding New Rules / 添加新规则**:
   - Create a new `.md` file in `rules/` directory
     在 `rules/` 目录中创建新的 `.md` 文件
   - Add `@file` reference in `index.md`
     在 `index.md` 中添加 `@file` 引用
   - Add skill rule in `skill-rules.json` for auto-activation
     在 `skill-rules.json` 中添加技能规则以实现自动激活
   - Follow bilingual format (English/Chinese)
     遵循双语格式（英文/中文）

2. **Updating Rules / 更新规则**:
   - Edit the corresponding rule file
     编辑相应的规则文件
   - Cursor will automatically apply changes
     Cursor 会自动应用更改
   - Keep both languages synchronized
     保持两种语言同步

3. **CLI Permissions / CLI 权限**:
   - Review `cli.json` when adding new tools
     添加新工具时审查 `cli.json`
   - Follow principle of least privilege
     遵循最小权限原则
   - Test permissions in development environment
     在开发环境中测试权限

## Compatibility / 兼容性

- **Cursor Version / Cursor 版本**: Supports `.cursor/rules/` directory structure with frontmatter
  支持带 frontmatter 的 `.cursor/rules/` 目录结构
- **Project Version / 项目版本**: 1.6.x
- **Last Updated / 最后更新**: 2026-01-05
- **Configuration Version / 配置版本**: 2.0.0 (with frontmatter and enhanced permissions)
  配置版本：2.0.0（带 frontmatter 和增强权限）
- **Skills / 技能**: 8 skills configured (backend, frontend, database, client, i18n, testing, performance, security)
  配置了 8 个技能（后端、前端、数据库、客户端、国际化、测试、性能、安全）

## Related Documentation / 相关文档

- [Cursor Official Docs](https://docs.cursor.com/)
- [Cursor Rules Documentation](https://docs.cursor.com/context/rules-for-ai)
- [Cursor CLI Configuration](https://docs.cursor.com/cli/reference/configuration)
- [Cursor Hooks Documentation](https://docs.cursor.com/agent/hooks)
- [Cursor Worktrees Configuration](https://docs.cursor.com/) - Worktree setup scripts

## Support / 支持

For questions or issues with Cursor configuration, please:
如有关于 Cursor 配置的问题或问题，请：

1. Check the rule files in `.cursor/rules/`
   检查 `.cursor/rules/` 中的规则文件
2. Review this README
   查看本 README
3. Consult Cursor official documentation
   查阅 Cursor 官方文档

