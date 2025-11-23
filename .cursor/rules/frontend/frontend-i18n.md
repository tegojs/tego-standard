---
description: Frontend internationalization - using translations, adding translation keys
globs:
  - packages/**/*.tsx
alwaysApply: false
---

# Frontend Internationalization / 前端国际化

## Using Translations / 使用翻译

```typescript
import { useTranslation } from 'react-i18next';

const { t } = useTranslation();
<Button>{t('Save')}</Button>
```

## Adding Translation Keys / 添加翻译键

**Important / 重要**：Must add translation keys to ALL language files / 必须将翻译键添加到所有语言文件：

```json
// en-US.json: { "Save": "Save" }
// zh-CN.json: { "Save": "保存" }
// ko_KR.json: { "Save": "저장" }
```
