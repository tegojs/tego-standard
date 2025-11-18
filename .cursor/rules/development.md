# Development Guide / 开发指南

## Creating New Modules/Plugins / 创建新模块/插件
1. Create a new directory under `packages/`.
   在 `packages/` 下创建新目录
2. Follow naming conventions: `module-*` or `plugin-*`.
   遵循命名规范：`module-*` 或 `plugin-*`
3. Create `package.json` with correct `name`, `version`, and dependencies.
   创建 `package.json`，设置正确的 `name`、`version` 和依赖
4. Add necessary TypeScript configuration.
   添加必要的 TypeScript 配置
5. Implement core functionality.
   实现核心功能

### Example: Creating a Plugin / 示例：创建插件

```typescript
// packages/plugin-my-feature/src/index.ts
import { Plugin } from '@tachybase/client'

export class MyFeaturePlugin extends Plugin {
  async load() {
    // Register components / 注册组件
    this.app.addComponents({
      MyFeatureComponent,
    })

    // Register routes / 注册路由
    this.app.addRoutes({
      path: '/my-feature',
      element: <MyFeaturePage />,
    })

    // Register menu items / 注册菜单项
    this.app.pluginManager.add('my-feature', {
      name: 'my-feature',
      displayName: 'My Feature',
      displayName: {
        'zh-CN': '我的功能',
      },
    })
  }
}
```

### Example: Creating a Module / 示例：创建模块

```typescript
// packages/module-my-module/src/server/index.ts
import { Module } from '@tego/server'

export class MyModule extends Module {
  async load() {
    // Register server-side functionality / 注册服务端功能
    this.app.db.defineCollection({
      name: 'myCollection',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'content', type: 'text' },
      ],
    })
  }
}
```

## Internationalization (i18n) / 国际化

### Translation File Synchronization / 翻译文件同步
- **Mandatory Rule / 必须规则**: When adding or modifying translations, **MUST** update **ALL** language files in the locale directory.
- **必须规则**：添加或修改翻译时，**必须**更新 locale 目录下的**所有**语言文件
- Do not only update Chinese (zh-CN) and English (en-US), but also update all other language files:
- 不要只更新中文（zh-CN）和英文（en-US），还要更新所有其他语言文件：
  - Korean (ko_KR.json)
  - Japanese (ja-JP.ts)
  - Portuguese (pt-BR.ts)
  - And any other language files that exist
  - 以及存在的任何其他语言文件

### Translation File Locations / 翻译文件位置
- Locale files are typically located in `packages/*/src/locale/` directory
- 翻译文件通常位于 `packages/*/src/locale/` 目录
- Common file formats: `.json`, `.ts`
- 常见文件格式：`.json`, `.ts`

### Workflow for Adding Translations / 添加翻译的工作流程
1. Identify all locale files in the target package / 识别目标包中的所有翻译文件
2. Add the translation key to **ALL** language files / 将翻译键添加到**所有**语言文件
3. Provide appropriate translations for each language / 为每种语言提供适当的翻译
4. If unsure of translation, use English as fallback or mark with TODO / 如果不确定翻译，使用英文作为后备或标记 TODO

### Example / 示例
```typescript
// ❌ Wrong - Only updating two files / 错误 - 只更新两个文件
// zh-CN.json: { "NewKey": "新键" }
// en-US.json: { "NewKey": "New Key" }

// ✅ Correct - Updating all files / 正确 - 更新所有文件
// zh-CN.json: { "NewKey": "新键" }
// en-US.json: { "NewKey": "New Key" }
// ko_KR.json: { "NewKey": "새 키" }
// ja-JP.ts: { NewKey: '新しいキー' }
// pt-BR.ts: { NewKey: 'Nova Chave' }
```

## Code Quality Check / 代码质量检查

### Lint Error Check / Lint 错误检查
- **Mandatory Rule / 必须规则**: After modifying any code file, must use `read_lints` tool to check for lint errors.
- **必须规则**：每次修改代码文件后，必须使用 `read_lints` 工具检查 lint 错误
- If lint errors are found, fix them immediately. Do not commit code with lint errors.
- 如果发现 lint 错误，必须立即修复，不能提交有 lint 错误的代码
- Check all modified files, especially TypeScript/JavaScript files (.ts, .tsx, .js, .jsx, .mjs).
- 检查所有修改过的文件，特别是 TypeScript/JavaScript 文件（.ts, .tsx, .js, .jsx, .mjs）
- Actively run lint checks after completing code modifications, don't wait for user reminders.
- 在完成代码修改后，应该主动运行 lint 检查，而不是等待用户提醒

### Code Modification Workflow / 代码修改流程
1. Modify code files / 修改代码文件
2. **Immediately check lint errors** (using read_lints tool) / **立即检查 lint 错误**（使用 read_lints 工具）
3. If errors found, fix them and check again / 如果发现错误，修复后再次检查
4. Confirm no errors before continuing / 确认无错误后再继续

## Commit Convention / 提交规范
- Use Conventional Commits format.
- 使用 Conventional Commits 格式
- Run `pnpm lint` before committing to check code.
- 提交前运行 `pnpm lint` 检查代码
- Commit message format: `<type>(<scope>): <description>`
  提交信息格式: `<type>(<scope>): <description>`
  - type: feat, fix, docs, style, refactor, test, chore
  - scope: package name or module name (optional)
    scope: 包名或模块名（可选）

### Examples / 示例

```bash
# Feature / 新功能
git commit -m "feat(client): add user profile component"

# Bug fix / 修复
git commit -m "fix(plugin-workflow): resolve approval flow issue"

# Documentation / 文档
git commit -m "docs: update API documentation"

# Refactoring / 重构
git commit -m "refactor(module-auth): simplify authentication logic"

# Test / 测试
git commit -m "test(client): add unit tests for UserService"

# Chore / 杂务
git commit -m "chore: update dependencies"
```

## Testing / 测试
- Unit tests use Vitest.
- 单元测试使用 Vitest
- E2E tests use Playwright.
- E2E 测试使用 Playwright
- Test file naming: `*.test.ts` or `*.spec.ts`
- 测试文件命名: `*.test.ts` 或 `*.spec.ts`

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

