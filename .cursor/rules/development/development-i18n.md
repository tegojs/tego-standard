---
description: Internationalization guidelines - translation file synchronization (Mandatory Rule)
globs:
  - packages/*/src/locale/**/*.{ts,json}
alwaysApply: true
---

# Internationalization (i18n) / 国际化

## Translation File Synchronization / 翻译文件同步

- **Mandatory Rule / 必须规则**: When adding or modifying translations, **MUST** update **ALL** language files.
- **必须规则**：添加或修改翻译时，**必须**更新**所有**语言文件
- Do not only update Chinese (zh-CN) and English (en-US), but also update all other language files.
- 不要只更新中文（zh-CN）和英文（en-US），还要更新所有其他语言文件

## Workflow for Adding Translations / 添加翻译的工作流程

1. Identify all locale files in the target package.
2. Add the translation key to **ALL** language files.
3. Provide appropriate translations for each language.
4. If unsure of translation, use English as fallback or mark with TODO.
