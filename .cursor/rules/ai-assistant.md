# AI Assistant Guide / AI 辅助开发指南

## Code Generation / 代码生成
- When generating new components, follow the project's component structure and naming conventions.
- 生成新组件时，遵循项目的组件结构和命名规范
- Automatically add necessary type definitions and imports.
- 自动添加必要的类型定义和导入
- Consider internationalization and accessibility.
- 考虑国际化和可访问性

## ⚠️ CRITICAL: Internationalization Checklist / ⚠️ 关键：国际化检查清单

**When adding or modifying translation keys, you MUST follow this checklist / 添加或修改翻译键时，必须遵循此检查清单：**

1. **Before completing code changes / 完成代码更改之前**:
   - [ ] Identify ALL locale files in the target package / 识别目标包中的所有语言文件
   - [ ] Add translation key to ALL language files (not just zh-CN and en-US) / 在所有语言文件中添加翻译键（不仅仅是 zh-CN 和 en-US）
   - [ ] Verify JSON/TypeScript syntax is correct in all files / 验证所有文件的 JSON/TypeScript 语法正确

2. **Common locale files to check / 需要检查的常见语言文件**:
   - `en-US.json` (English)
   - `zh-CN.json` (Chinese Simplified)
   - `ko_KR.json` (Korean)
   - `ja-JP.ts` or `ja-JP.json` (Japanese)
   - `pt-BR.ts` or `pt-BR.json` (Portuguese)
   - `fr-FR.json` (French, if exists)
   - `es-ES.json` (Spanish, if exists)
   - `ru-RU.json` (Russian, if exists)
   - `tr-TR.json` (Turkish, if exists)

3. **Workflow / 工作流程**:
   - Step 1: Add key to one file (usually `en-US.json` or `zh-CN.json`) / 步骤 1：在一个文件中添加键（通常是 `en-US.json` 或 `zh-CN.json`）
   - Step 2: **IMMEDIATELY** add the same key to ALL other locale files / 步骤 2：**立即**在所有其他语言文件中添加相同的键
   - Step 3: Provide appropriate translations for each language / 步骤 3：为每种语言提供适当的翻译
   - Step 4: Verify all files are updated before completing / 步骤 4：在完成之前验证所有文件都已更新

4. **DO NOT / 不要**:
   - ❌ Only update zh-CN.json and en-US.json / 只更新 zh-CN.json 和 en-US.json
   - ❌ Leave translation keys incomplete / 留下不完整的翻译键
   - ❌ Commit code with incomplete translations / 提交不完整翻译的代码

**Reference / 参考**: See `.cursor/rules/development.md` and `.cursor/rules/lint-check.md` for detailed rules / 详细规则请参见 `.cursor/rules/development.md` 和 `.cursor/rules/lint-check.md`

## Code Refactoring / 代码重构
- Maintain API compatibility when refactoring.
- 重构时保持 API 兼容性
- Update related tests and documentation.
- 更新相关测试和文档
- Check dependency relationships.
- 检查依赖关系

## Troubleshooting / 问题排查
- Check console errors and logs.
- 查看控制台错误和日志
- Check TypeScript type errors.
- 检查 TypeScript 类型错误
- Verify dependency version compatibility.
- 验证依赖版本兼容性
- Check GitHub Actions workflow status.
- 查看 GitHub Actions 工作流状态

