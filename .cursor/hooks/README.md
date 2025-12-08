# Cursor Hooks 配置说明

根据 [Cursor 官方文档](https://cursor.com/cn/docs/agent/hooks)，hooks 配置文件需要放在用户主目录。

## 关于路径匹配 / About Path Matching

**重要说明**：`hooks.json` 目前不支持路径模式匹配（如 glob 模式或正则表达式）。每个 hook 定义只支持 `command` 属性。

**Important Note**: `hooks.json` currently does not support path pattern matching (such as glob patterns or regular expressions). Each hook definition only supports the `command` property.

如果需要根据文件路径条件执行不同的操作，需要在脚本内部进行路径检查（如 `sync-locale.sh` 的做法）。

If you need to execute different operations based on file paths, you need to perform path checks inside the script (as done in `sync-locale.sh`).

## 配置步骤

### 方法 1：使用快速设置脚本（推荐）

在项目根目录运行：

```bash
./.cursor/hooks/setup.sh
```

### 方法 2：手动复制配置

将项目中的 hooks 配置复制到用户主目录：

```bash
# 创建用户主目录的 .cursor 目录（如果不存在）
mkdir -p ~/.cursor/hooks

# 复制 hooks.json
cp .cursor/hooks.json ~/.cursor/hooks.json

# 复制格式化脚本
cp .cursor/hooks/format.sh ~/.cursor/hooks/format.sh
chmod +x ~/.cursor/hooks/format.sh

# 复制翻译同步脚本
cp .cursor/hooks/sync-locale.sh ~/.cursor/hooks/sync-locale.sh
chmod +x ~/.cursor/hooks/sync-locale.sh
```

### 2. 验证配置

重启 Cursor 后，hooks 会自动生效。你可以在 Cursor 设置的 Hooks 选项卡中查看已配置的 hooks。

## Hook 功能说明

### afterFileEdit Hook

在文件编辑完成后自动执行以下操作：

#### 1. 代码格式化 (format.sh)

自动运行代码格式化。

**支持的文件类型：**
- JavaScript: `.js`, `.jsx`
- TypeScript: `.ts`, `.tsx`
- JSON: `.json`
- SQL: `.sql`
- Markdown: `.md`

**格式化工具：**
- 使用项目配置的 Prettier（`.prettierrc.mjs`）
- 自动检测并使用 `prettier`、`pnpm exec prettier` 或 `npx prettier`

#### 2. 翻译同步提醒 (sync-locale.sh)

当编辑 `locale` 文件夹下的文件时，检测并提醒 AI 需要同步翻译键到所有语言包。

**触发条件：**
- 仅在编辑 `locale` 目录下的文件时执行
- 虽然 `afterFileEdit` hook 会在所有文件编辑后触发，但此脚本会在开头快速检查
- 如果不是 locale 文件，会立即退出，几乎没有任何性能开销

**支持的文件类型：**
- JSON 格式：`.json`（如 `en-US.json`, `zh-CN.json`）
- TypeScript 格式：`.ts`（如 `en-US.ts`, `zh-CN.ts`）

**功能特性：**
- 快速检测：在脚本开头立即检查文件路径，非 locale 文件立即退出
- 自动检测编辑的文件是否在 `locale` 目录下
- 查找同目录下的所有其他语言文件
- 输出提醒信息，提示 AI 需要同步翻译
- **注意**：此 hook 只负责检测和提醒，实际的同步操作由 AI 根据规则自动执行

**工作流程：**
1. Hook 检测到 locale 文件被编辑
2. Hook 输出提醒信息，列出需要同步的语言文件
3. AI 根据 `.cursor/rules/lint-check.md` 中的规则自动执行同步操作
4. AI 将新增的翻译键添加到所有其他语言文件中

**示例：**

编辑 `packages/module-backup/src/locale/en-US.json` 添加新键后，hook 会输出：
```
⚠️  检测到 locale 文件编辑: /path/to/en-US.json
📝 请检查并同步新增的翻译键到同目录下的所有语言文件:
   - zh-CN.json
   - ko_KR.json
```

然后 AI 会自动执行同步操作。

## 配置文件位置

### 用户主目录（推荐）
- `~/.cursor/hooks.json`
- `~/.cursor/hooks/format.sh`
- `~/.cursor/hooks/sync-locale.sh`

### 项目目录（参考模板）
- `.cursor/hooks.json`（项目中的模板）
- `.cursor/hooks/format.sh`（项目中的模板）
- `.cursor/hooks/sync-locale.sh`（项目中的模板）

## 故障排除

如果 hooks 无法正常工作：

1. **检查脚本权限**
   ```bash
   chmod +x ~/.cursor/hooks/format.sh
   chmod +x ~/.cursor/hooks/sync-locale.sh
   ```

2. **检查依赖工具**
   ```bash
   # 检查 Prettier
   pnpm exec prettier --version
   
   # 检查 Node.js（翻译同步需要）
   node --version
   ```

3. **重启 Cursor**
   - 完全退出 Cursor
   - 重新启动 Cursor

4. **查看 Hooks 输出**
   - 在 Cursor 设置中打开 Hooks 选项卡
   - 查看 Hooks 输出通道中的错误信息

5. **测试脚本**
   ```bash
   # 测试格式化脚本
   echo '{"file_path": "/path/to/test.ts"}' | ~/.cursor/hooks/format.sh
   
   # 测试翻译同步脚本
   echo '{"file_path": "/path/to/locale/en-US.json"}' | ~/.cursor/hooks/sync-locale.sh
   ```

## 参考文档

- [Cursor Hooks 官方文档](https://cursor.com/cn/docs/agent/hooks)

