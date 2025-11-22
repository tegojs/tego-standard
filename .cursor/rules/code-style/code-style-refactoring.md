---
description: Code refactoring principles - DRY, extracting common functions
globs:
  - packages/**/*.ts
  - packages/**/*.tsx
  - apps/**/*.ts
  - apps/**/*.tsx
alwaysApply: false
---

# Code Refactoring Principles / 代码重构原则

## DRY (Don't Repeat Yourself) / DRY 原则

- **Core Principle / 核心原则**: Eliminate duplicate code by extracting common logic into reusable functions.
- **核心原则**：通过提取公共逻辑到可复用函数来消除重复代码
- When you find identical or similar code blocks in multiple places, extract them into a shared function.
- 当发现多个地方有相同或相似的代码块时，应提取为共享函数

## When to Refactor / 何时重构

- **Duplicate Logic / 重复逻辑**: If the same logic appears in 2+ places, extract it.
- **重复逻辑**：如果相同逻辑出现在 2 个或更多地方，应提取它
- **Similar Patterns / 相似模式**: If similar code patterns exist with only minor differences, parameterize them.
- **相似模式**：如果存在仅细微差异的相似代码模式，应参数化它们

## Refactoring Workflow / 重构流程

1. **Identify Duplication / 识别重复**: Look for similar code blocks or patterns.
2. **Extract Common Logic / 提取公共逻辑**: Create a shared function with parameters.
3. **Replace Duplicates / 替换重复**: Update all occurrences to use the new function.
4. **Test / 测试**: Verify that behavior remains unchanged.
5. **Check Lint Errors / 检查 Lint 错误**: Run lint checks after refactoring.
