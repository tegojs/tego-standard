---
description: Testing patterns and best practices for Vitest/Playwright
globs:
  - **/*.test.ts
  - **/*.spec.ts
  - **/__tests__/**/*.ts
  - **/e2e/**/*.ts
alwaysApply: false
---

# Testing Guidelines / 测试指南

This document provides comprehensive testing guidelines for the Tego project, covering unit tests, integration tests, and E2E tests.

本文档提供 Tego 项目的全面测试指南，涵盖单元测试、集成测试和 E2E 测试。

## Quick Navigation / 快速导航

- [Unit Tests / 单元测试](resources/testing/unit-tests.md) - Testing individual functions and components
  测试独立的函数和组件
- [Integration Tests / 集成测试](resources/testing/integration-tests.md) - Testing component interactions
  测试组件交互
- [E2E Tests / E2E 测试](resources/testing/e2e-tests.md) - Testing complete user flows
  测试完整的用户流程
- [Mocking Patterns / 模拟模式](resources/testing/mocking.md) - Mocking dependencies and external services
  模拟依赖和外部服务

## Testing Framework / 测试框架

- **Unit/Integration Tests**: Vitest
- **E2E Tests**: Playwright
- **Test Utilities**: `@tachybase/test` package

## Core Principles / 核心原则

1. **Test Isolation / 测试隔离**
   - Each test should be independent / 每个测试应该是独立的
   - Use `beforeEach` and `afterEach` for setup/teardown / 使用 `beforeEach` 和 `afterEach` 进行设置/清理

2. **Arrange-Act-Assert Pattern / 安排-执行-断言模式**
   ```typescript
   it('should calculate total', () => {
     // Arrange / 安排
     const items = [{ price: 10 }, { price: 20 }];
     
     // Act / 执行
     const total = calculateTotal(items);
     
     // Assert / 断言
     expect(total).toBe(30);
   });
   ```

3. **Descriptive Test Names / 描述性测试名称**
   ```typescript
   // ✅ Good / 好的
   it('should return user data when valid ID is provided', () => {});
   
   // ❌ Bad / 不好的
   it('test1', () => {});
   ```

## Test File Structure / 测试文件结构

### Unit/Integration Tests / 单元/集成测试

- **Location / 位置**: `packages/*/src/__tests__/**/*.test.ts`
- **Naming / 命名**: `*.test.ts` or `*.spec.ts`

### E2E Tests / E2E 测试

- **Location / 位置**: `packages/*/e2e/**/*.test.ts` or `packages/*/__e2e__/**/*.test.ts`

## Test Coverage / 测试覆盖率

### Coverage Thresholds / 覆盖率阈值

- **Lines**: 60%
- **Branches**: 60%
- **Functions**: 80%
- **Statements**: 80%

### Running Coverage / 运行覆盖率

```bash
# Run tests with coverage / 运行测试并生成覆盖率报告
pnpm test --coverage

# View coverage report / 查看覆盖率报告
open coverage/index.html
```

## Focused Validation / 聚焦验证

- Prefer the smallest targeted command that proves the touched behavior before running the full suite.
- 优先运行能证明当前改动的最小聚焦命令，不要一开始就跑全量测试。
- Do not run the full test suite or full monorepo build for a narrow change. Escalate to full validation only for shared-core or cross-package changes, release validation, unexplained broader regressions, or an explicit user request.
- 窄范围改动不要运行全量测试或整个 monorepo 构建。仅在修改共享核心或跨包契约、执行发布验证、出现无法解释的广泛回归，或用户明确要求时升级为全量验证。
- Use direct Vitest file runs for narrow server/client changes:
- 对窄范围服务端或客户端改动，优先直接运行对应 Vitest 文件：

```bash
pnpm exec vitest run packages/<package>/src/**/__tests__/<test-file>.test.ts --reporter=default
```

- Run `pnpm exec oxlint <changed-files>` after TypeScript/JavaScript changes when a narrower lint check is enough.
- 修改 TypeScript/JavaScript 后，如无需全量 lint，可先运行 `pnpm exec oxlint <changed-files>`。
- Run the relevant package build when adding runtime dependencies, changing exported types, modifying build-sensitive code, or fixing a CI build failure.
- 添加运行时依赖、修改导出类型、触碰构建敏感代码或修复 CI 构建失败时，必须跑相关包构建。
- After build commands, check `git status --short` and keep generated artifacts out of the commit unless they are intentional deliverables.
- 构建命令后检查 `git status --short`，不要把非预期生成产物带进提交。
- When changing package dependencies or catalog entries, use `pnpm` and commit the updated lockfile together with the package change.
- 修改 package 依赖或 catalog 条目时，使用 `pnpm`，并把 lockfile 与 package 变更一起提交。
- Scale tests with behavioral risk. Metadata and translation-only changes normally need schema, syntax, formatting, and rendering checks rather than new unit tests; runtime behavior changes require focused regression coverage.
- 测试投入应与行为风险匹配。元数据和纯翻译修改通常只需检查结构、语法、格式和渲染，无需新增单元测试；运行时行为变更必须补充聚焦的回归测试。

## Real-Path Verification / 真实路径验证

- For UI or API bugs that depend on schemas, authentication, roles, tenant selection, or persisted business data, reproduce the reported user path against the local development server when the required environment is available.
- 对依赖页面 Schema、登录状态、角色、租户选择或真实业务数据的 UI/API Bug，在环境可用时应通过本地开发服务器复现用户报告的真实路径。
- Explicitly verify the active user, role, and tenant before drawing conclusions. Capture the failing request and relevant server log or stack, then trace the value to the owning layer.
- 下结论前必须确认当前用户、角色和租户。记录失败请求及相关服务端日志或堆栈，再沿数据流定位到真正负责的层级。
- After the fix, repeat the original workflow end to end and verify persisted data and downstream status, not only the HTTP status. Add the smallest automated regression test that preserves the underlying contract.
- 修复后应端到端重跑原始流程，并核对持久化数据与后续状态，不能只看 HTTP 状态码。同时增加能固定底层契约的最小自动化回归测试。
- Production investigation is read-only unless the user explicitly authorizes a write. Prefer reproducing writes locally with restored data.
- 除非用户明确授权写操作，生产环境排查必须保持只读。涉及写入的复现优先在已还原数据的本地环境完成。
- If an environment failure prevents a required check, report the exact blocked command and error. Do not claim that check passed and do not modify dependencies merely to work around the local runner.
- 如果环境故障阻止必要验证，应报告被阻塞的具体命令和错误；不得声称该检查已通过，也不要仅为绕过本地运行器问题而修改依赖。

## Common Test Patterns / 常见测试模式

### Testing Async Operations / 测试异步操作

```typescript
it('should handle async operation', async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

### Testing Error Handling / 测试错误处理

```typescript
it('should throw error for invalid input', async () => {
  await expect(asyncFunction(null)).rejects.toThrow('Invalid input');
});
```

### Testing Forms / 测试表单

```typescript
it('should submit form with valid data', async () => {
  const onSubmit = vi.fn();
  const { user } = render(<Form onSubmit={onSubmit} />);
  
  await user.type(screen.getByLabelText('Name'), 'Test');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  
  expect(onSubmit).toHaveBeenCalledWith({ name: 'Test' });
});
```

## Checklist / 检查清单

### Before Writing Tests / 编写测试前

- [ ] Understand what needs to be tested / 理解需要测试的内容
- [ ] Identify test cases (happy path, edge cases, error cases) / 识别测试用例（正常路径、边界情况、错误情况）
- [ ] Set up test environment / 设置测试环境

### While Writing Tests / 编写测试时

- [ ] Follow Arrange-Act-Assert pattern / 遵循安排-执行-断言模式
- [ ] Use descriptive test names / 使用描述性测试名称
- [ ] Keep tests focused and simple / 保持测试专注和简单
- [ ] Mock external dependencies / 模拟外部依赖
- [ ] Clean up resources in `afterEach` / 在 `afterEach` 中清理资源

### After Writing Tests / 编写测试后

- [ ] Run tests locally / 本地运行测试
- [ ] Check test coverage / 检查测试覆盖率
- [ ] Ensure tests are independent / 确保测试是独立的
- [ ] Review test code quality / 审查测试代码质量

## Resources / 资源

- **Vitest Documentation**: https://vitest.dev/
- **Playwright Documentation**: https://playwright.dev/
- **Testing Library**: https://testing-library.com/
