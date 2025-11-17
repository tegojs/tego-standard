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

## Important Notes / 重要提示

- **Do not commit code with lint errors** / **不能提交有 lint 错误的代码**
- Actively run lint checks after completing code modifications, don't wait for user reminders / 在完成代码修改后，应该主动运行 lint 检查，而不是等待用户提醒
- If lint errors are found, must fix them immediately, cannot ignore / 如果发现 lint 错误，必须立即修复，不能忽略

