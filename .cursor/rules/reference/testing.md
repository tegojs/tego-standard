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
