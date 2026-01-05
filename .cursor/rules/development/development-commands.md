---
description: Common development commands - dev, build, test, lint
globs:
  - **/*
alwaysApply: false
---

# Common Commands / 常用命令

## Development / 开发

```bash
pnpm dev              # Start development server / 启动开发服务器
pnpm dev-local        # Start with local env vars (.env.local) / 使用本地环境变量启动
pnpm dev-server       # Start server only / 仅启动服务器
pnpm start            # Start production server / 启动生产服务器
```

## Build / 构建

```bash
pnpm build            # Build all packages / 构建所有包
pnpm build:p          # Production build (skip .d.ts) / 快速构建（跳过类型声明）
pnpm clean            # Clean build artifacts / 清理构建产物
```

## Code Quality / 代码质量

```bash
pnpm lint             # Run oxlint check / 运行 oxlint 检查
pnpm test             # Run all tests / 运行所有测试
pnpm tc               # Run client tests (alias for test:client) / 运行客户端测试
pnpm ts               # Run server tests (alias for test:server) / 运行服务端测试
pnpm e2e              # Run E2E tests (Playwright) / E2E 测试
```

## Package Management / 包管理

```bash
pnpm install          # Install dependencies / 安装依赖
pnpm tgi              # tego install / 安装 tego
pnpm tgu              # tego upgrade / 升级 tego
```
