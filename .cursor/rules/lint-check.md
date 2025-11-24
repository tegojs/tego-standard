# Lint Error Check Rules / Lint 错误检查规则

## Mandatory Rule / 必须规则

After modifying any code file, must use `read_lints` tool to check for lint errors.

每次修改代码文件后，必须使用 `read_lints` 工具检查 lint 错误。

## Check Workflow / 检查流程

1. Modify code files / 修改代码文件
2. **Immediately check lint errors** (using read_lints tool) / **立即检查 lint 错误**（使用 read_lints 工具）
3. If errors found, fix them immediately / 如果发现错误，立即修复
4. After fixing, check again to confirm no errors / 修复后再次检查，确认无错误
5. Confirm no errors before continuing other operations / 确认无错误后再继续其他操作

## Check Scope / 检查范围

- All modified files / 修改过的所有文件
- Especially TypeScript/JavaScript files (.ts, .tsx, .js, .jsx, .mjs) / 特别是 TypeScript/JavaScript 文件（.ts, .tsx, .js, .jsx, .mjs）
- Workflow configuration files (.yaml, .yml) / 工作流配置文件（.yaml, .yml）

## Example / 示例

After modifying files, should execute:
修改文件后应该执行：

```typescript
read_lints({ paths: ['modified/file/path'] })
read_lints({ paths: ['修改的文件路径'] })
```

## Code Completion Checklist / 代码完成检查清单

After completing any code modifications, you must perform the following checks:

每次完成代码修改后，必须执行以下检查：

### 1. Remove Unused Code / 清理无用代码

#### 1.1 Remove Unused Imports and Exports / 删除未使用的导入和导出

- **Check all modified files** for unused imports and exports / **检查所有修改的文件**中未使用的导入和导出
- Remove any imports that are not used in the code / 删除代码中未使用的导入
- Remove any exports that are not referenced elsewhere / 删除在其他地方未引用的导出
- Use tools or manual review to identify unused code / 使用工具或手动审查来识别未使用的代码

**Example / 示例:**
```typescript
// ❌ Bad: Unused import / 不好的：未使用的导入
import { useState, useEffect, useMemo } from 'react'
// Only useState is used / 只使用了 useState

// ✅ Good: Only import what's needed / 好的：只导入需要的
import { useState } from 'react'
```

#### 1.2 Remove Unused Variables and Functions / 删除未使用的变量和函数

- **Check for unused variables** declared but never used / **检查未使用的变量**（声明但从未使用）
- **Check for unused functions** defined but never called / **检查未使用的函数**（定义但从未调用）
- **Check for unused type definitions** that are not referenced / **检查未使用的类型定义**（未被引用）
- Remove dead code (code that is unreachable or never executed) / 删除死代码（无法到达或从未执行的代码）

**Example / 示例:**
```typescript
// ❌ Bad: Unused variable / 不好的：未使用的变量
const unusedVar = 'test'
const result = calculateValue()

// ❌ Bad: Unused function / 不好的：未使用的函数
function helperFunction() {
  return 'unused'
}

// ✅ Good: Remove unused code / 好的：删除未使用的代码
const result = calculateValue()
```

#### 1.3 Remove Commented Code / 删除注释掉的代码

- **Remove commented-out code blocks** unless they serve as documentation / **删除注释掉的代码块**（除非它们作为文档）
- Commented code should be removed before committing / 提交前应删除注释掉的代码
- If code needs to be preserved, use proper documentation comments instead / 如果需要保留代码，应使用适当的文档注释

**Example / 示例:**
```typescript
// ❌ Bad: Commented code / 不好的：注释掉的代码
// function oldFunction() {
//   return 'old'
// }
function newFunction() {
  return 'new'
}

// ✅ Good: Remove commented code / 好的：删除注释掉的代码
function newFunction() {
  return 'new'
}
```

#### 1.4 Remove Debug Code / 删除调试代码

- **Remove console.log statements** unless they are intentional logging (see development.md for debug logging rules) / **删除 console.log 语句**（除非是有意的日志记录，参见 development.md 中的调试日志规则）
- **Remove debug breakpoints** and temporary debugging code / **删除调试断点**和临时调试代码
- **Remove test/demo code** that was added for testing purposes / **删除测试/演示代码**（为测试目的而添加的）

**Example / 示例:**
```typescript
// ❌ Bad: Debug code / 不好的：调试代码
console.log('debug value:', value)
function processData(data) {
  return data
}

// ✅ Good: Remove debug code / 好的：删除调试代码
function processData(data) {
  return data
}

// ✅ Good: Intentional logging with timestamp (see development.md) / 好的：带时间戳的有意日志（参见 development.md）
const timestamp = new Date().toISOString()
this.app.logger.info(`[${timestamp}] Processing data`, { data })
```

### 2. Synchronize All Translation Files / 同步所有翻译文件

**MANDATORY RULE / 必须规则**: When editing any file in a `locale` directory, you MUST immediately synchronize all translation keys to all other language files in the same directory.

**必须规则**：当编辑 `locale` 目录下的任何文件时，必须立即将所有翻译键同步到同目录下的所有其他语言文件。

When adding or modifying translation keys, you must:

当添加或修改翻译键时，必须：

- **Add the translation key to ALL language files** in the locale directory / **在所有语言文件中添加翻译键**
- Common language files include: `en-US.json`, `zh-CN.json`, `es-ES.json`, `fr-FR.json`, `ja-JP.json`, `ko_KR.json`, `pt-BR.json`, `ru-RU.json`, `tr-TR.json` / 常见语言文件包括：`en-US.json`, `zh-CN.json`, `es-ES.json`, `fr-FR.json`, `ja-JP.json`, `ko_KR.json`, `pt-BR.json`, `ru-RU.json`, `tr-TR.json`
- Support both JSON (`.json`) and TypeScript (`.ts`) locale file formats / 支持 JSON (`.json`) 和 TypeScript (`.ts`) 两种 locale 文件格式
- Ensure all translation keys are in the same order across all files / 确保所有文件中的翻译键顺序一致
- Use appropriate translations for each language / 为每种语言使用适当的翻译
- For new keys added to other language files, use the key name as the default value (to be translated later) / 对于添加到其他语言文件的新键，使用键名作为默认值（待后续翻译）

**Workflow / 工作流程:**
1. Edit a locale file (e.g., `en-US.json` or `zh-CN.json`) / 编辑 locale 文件（如 `en-US.json` 或 `zh-CN.json`）
2. **IMMEDIATELY check all other language files in the same directory** / **立即检查同目录下的所有其他语言文件**
3. **Add any missing translation keys to all other language files** / **将所有缺失的翻译键添加到所有其他语言文件**
4. For new keys, use the key name as the default value in other language files / 对于新键，在其他语言文件中使用键名作为默认值
5. Provide appropriate translations for each language / 为每种语言提供适当的翻译
6. Verify JSON/TypeScript syntax is correct in all files / 验证所有文件的 JSON/TypeScript 语法正确

**Example / 示例:**
```json
// en-US.json
{
  "Failed to create execution": "Failed to create execution",
  "Test execution failed": "Test execution failed"
}

// zh-CN.json (must also add) / 必须也添加
{
  "Failed to create execution": "创建执行记录失败",
  "Test execution failed": "测试执行失败"
}

// es-ES.json (must also add) / 必须也添加
{
  "Failed to create execution": "Error al crear la ejecución",
  "Test execution failed": "Error en la ejecución de prueba"
}
// ... and so on for all language files / ... 对所有语言文件都如此
```

## Important Notes / 重要提示

- **Do not commit code with lint errors** / **不能提交有 lint 错误的代码**
- **Do not commit code with unused imports/exports** / **不能提交带有未使用导入/导出的代码**
- **Do not commit code with unused variables/functions** / **不能提交带有未使用变量/函数的代码**
- **Do not commit commented-out code** / **不能提交注释掉的代码**
- **Do not commit debug code** (console.log, breakpoints, etc.) / **不能提交调试代码**（console.log、断点等）
- **Do not commit incomplete translations** / **不能提交不完整的翻译**
- Actively run lint checks after completing code modifications, don't wait for user reminders / 在完成代码修改后，应该主动运行 lint 检查，而不是等待用户提醒
- If lint errors are found, must fix them immediately, cannot ignore / 如果发现 lint 错误，必须立即修复，不能忽略
- Always check for unused code before completing code changes / 在完成代码更改之前，始终检查未使用的代码
- Always synchronize translations across all language files / 始终在所有语言文件之间同步翻译

## Cleanup Checklist / 清理检查清单

Before completing code modifications, ensure:
在完成代码修改之前，确保：

- [ ] All lint errors are fixed / 所有 lint 错误已修复
- [ ] Unused imports are removed / 未使用的导入已删除
- [ ] Unused exports are removed / 未使用的导出已删除
- [ ] Unused variables are removed / 未使用的变量已删除
- [ ] Unused functions are removed / 未使用的函数已删除
- [ ] Unused type definitions are removed / 未使用的类型定义已删除
- [ ] Commented-out code is removed / 注释掉的代码已删除
- [ ] Debug code (console.log, breakpoints) is removed / 调试代码（console.log、断点）已删除
- [ ] All translation files are synchronized / 所有翻译文件已同步

