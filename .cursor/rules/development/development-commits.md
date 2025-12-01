---
description: Commit conventions - Conventional Commits format
globs:
  - **/*
alwaysApply: false
---

# Commit Convention / 提交规范

- Use Conventional Commits format.
- 使用 Conventional Commits 格式
- Run `pnpm lint` before committing to check code.
- 提交前运行 `pnpm lint` 检查代码
- Commit message format: `<type>(<scope>): <description>`
- 提交信息格式: `<type>(<scope>): <description>`
  - type: feat, fix, docs, style, refactor, test, chore
  - scope: package name or module name (optional)

## Examples / 示例

```bash
git commit -m "feat(client): add user profile component"
git commit -m "fix(plugin-workflow): resolve approval flow issue"
git commit -m "docs: update API documentation"
```
