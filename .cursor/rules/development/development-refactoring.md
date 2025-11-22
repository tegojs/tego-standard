---
description: Code refactoring guidelines - extracting code to separate files
globs:
  - packages/**/*.ts
  - packages/**/*.tsx
alwaysApply: false
---

# Code Refactoring / 代码重构

## Extracting Code to Separate Files / 提取代码到独立文件

When a feature module becomes large or has independent functionality, consider extracting it to a separate file.

当某个功能模块变得庞大或具有独立功能时，考虑将其提取到独立文件中。

## When to Extract / 何时提取

1. **Feature Independence / 功能独立性**: The code represents a cohesive, independent feature.
2. **Code Volume / 代码量**: A single file exceeds 500-800 lines.
3. **Reusability / 可复用性**: The code can be reused in multiple places.
4. **Separation of Concerns / 关注点分离**: The code handles a different concern.
5. **Testability / 可测试性**: Extracting makes the code easier to test.

## Extraction Process / 提取流程

1. Create new file with descriptive name.
2. Define clear interfaces using TypeScript.
3. Use dependency injection for dependencies.
4. Update all references.
5. Remove old code from original file.
