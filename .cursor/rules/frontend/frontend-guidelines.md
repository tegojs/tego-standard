---
description: Frontend development overview - see specific rule files for details
globs:
  - packages/client/src/**/*.tsx
  - packages/module-*/src/**/*.tsx
  - packages/plugin-*/src/**/*.tsx
  - packages/*/src/client/**/*.tsx
  - **/components/**/*.tsx
alwaysApply: false
---

# Frontend Development Guidelines / 前端开发指南

This file provides an overview. For detailed guidelines, see:
本文件提供概览。详细指南请参见：

- `frontend-components.md` - Component patterns and hooks
- `frontend-state.md` - State management
- `frontend-performance.md` - Performance optimization
- `frontend-typescript.md` - TypeScript best practices
- `frontend-i18n.md` - Internationalization
- `frontend-best-practices.md` - Best practices

## Quick Start / 快速开始

### New Component Checklist / 新组件清单

- [ ] **Component Structure / 组件结构**: Clear component hierarchy
- [ ] **Type Definitions / 类型定义**: Complete TypeScript types
- [ ] **State Management / 状态管理**: Proper use of hooks
- [ ] **Styling / 样式**: Consistent styling approach
- [ ] **Error Handling / 错误处理**: Loading and error states
- [ ] **Testing / 测试**: Component tests
- [ ] **Internationalization / 国际化**: Translation keys added to all locale files

## File Organization / 文件组织

```
packages/module-*/src/client/
├── components/         # React components
├── hooks/              # Custom hooks
├── locale/             # Translation files
└── index.ts            # Exports
```

