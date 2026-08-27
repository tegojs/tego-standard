---
description: Commit conventions - Conventional Commits format
globs:
  - **/*
alwaysApply: false
---

# Commit Convention / 提交规范

- Use Conventional Commits format.
- 使用 Conventional Commits 格式
- Run focused lint, tests, and package builds appropriate to the changed files before committing. Do not default to repository-wide lint, tests, or builds for a narrow change.
- 提交前运行与改动文件匹配的聚焦 lint、测试和包级构建。窄范围改动不要默认运行全仓 lint、测试或构建。
- Commit message format: `<type>(<scope>): <description>`
- 提交信息格式: `<type>(<scope>): <description>`
  - type: feat, fix, docs, style, refactor, test, chore
  - scope: package name or module name (optional)
- Write commit subjects in concise English, following the existing repository history.
- 提交标题使用简洁英文，与仓库现有提交历史保持一致。
- Keep each commit atomic. Commit only when requested, and never push unless the user explicitly requests a push.
- 每个提交保持原子性。仅在用户要求时提交，且只有用户明确要求推送时才可以推送。

## Examples / 示例

```bash
git commit -m "feat(client): add user profile component"
git commit -m "fix(plugin-workflow): resolve approval flow issue"
git commit -m "docs: update API documentation"
```
