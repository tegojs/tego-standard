---
description: Common development commands - dev, build, test, lint
globs:
  - **/*
alwaysApply: false
---

# Common Commands / 常用命令

## Development / 开发

```bash
pnpm dev              # Start development server
pnpm dev-local        # Start with local env vars
pnpm dev-server       # Start server only
pnpm start            # Start production server
```

## Build / 构建

```bash
pnpm build            # Build all packages
pnpm build:p          # Production build
pnpm clean            # Clean build artifacts
```

## Code Quality / 代码质量

```bash
pnpm lint             # Run oxlint check
pnpm test             # Run all tests
pnpm test:client      # Run client tests
pnpm test:server      # Run server tests
```
