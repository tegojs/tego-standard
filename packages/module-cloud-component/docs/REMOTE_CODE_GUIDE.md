# 远程代码获取功能使用指南 / Remote Code Fetching Guide

## 功能概述 / Overview

云组件插件现在支持从远程地址获取代码，包括：
- **CDN 地址**：直接从 CDN 获取编译后的代码文件
- **Git 仓库**：从 GitHub/GitLab 等 Git 仓库获取源代码

The Cloud Component plugin now supports fetching code from remote sources, including:
- **CDN URLs**: Fetch compiled code files directly from CDN
- **Git Repositories**: Fetch source code from GitHub/GitLab repositories

## 配置方式 / Configuration

### 1. 代码来源选择 / Code Source Selection

在创建或编辑云组件时，可以选择代码来源：
- **本地代码 (Local code)**: 在编辑器中直接编写代码
- **远程代码 (Remote code)**: 从远程地址获取代码

When creating or editing a cloud component, you can choose the code source:
- **Local code**: Write code directly in the editor
- **Remote code**: Fetch code from a remote URL

### 2. CDN 配置 / CDN Configuration

如果选择远程代码并配置 CDN 地址：

If you choose remote code and configure a CDN URL:

```
代码来源: 远程代码
代码类型: CDN
代码地址: https://cdn.example.com/components/MyComponent.tsx
```

**示例 / Example:**
- `https://unpkg.com/@myorg/components@latest/dist/MyComponent.js`
- `https://cdn.jsdelivr.net/npm/@myorg/components@1.0.0/dist/MyComponent.js`

### 3. Git 仓库配置 / Git Repository Configuration

如果选择远程代码并配置 Git 仓库地址：

If you choose remote code and configure a Git repository URL:

```
代码来源: 远程代码
代码类型: Git
代码地址: https://github.com/owner/repo
代码分支: main (可选，默认为 main)
代码路径: src/components/MyComponent.tsx (可选)
```

**支持的 Git 平台 / Supported Git Platforms:**
- GitHub: `https://github.com/owner/repo`
- GitLab: `https://gitlab.com/owner/repo`

**示例 / Examples:**

1. **GitHub 示例 / GitHub Example:**
   ```
   代码地址: https://github.com/myorg/cloud-components
   代码分支: main
   代码路径: src/components/Button.tsx
   ```
   实际获取地址: `https://raw.githubusercontent.com/myorg/cloud-components/main/src/components/Button.tsx`

2. **GitLab 示例 / GitLab Example:**
   ```
   代码地址: https://gitlab.com/myorg/cloud-components
   代码分支: develop
   代码路径: components/Button.tsx
   ```
   实际获取地址: `https://gitlab.com/myorg/cloud-components/-/raw/develop/components/Button.tsx`

## 缓存机制 / Caching Mechanism

为了提升性能和减少网络请求，系统实现了代码缓存机制：

To improve performance and reduce network requests, the system implements a code caching mechanism:

- **缓存存储 / Cache Storage**: 代码缓存在数据库中，持久化保存
- **缓存使用 / Cache Usage**: 如果缓存存在，直接使用缓存中的代码
- **缓存更新 / Cache Update**: 首次获取或手动刷新时，从远程获取最新代码并更新缓存
- **缓存失效 / Cache Fallback**: 如果远程获取失败，会使用缓存的代码作为后备

- **Cache Storage**: Code cache is stored in database, persisted across restarts
- **Cache Usage**: If cache exists, directly use cached code
- **Cache Update**: On first fetch or manual refresh, fetch latest code from remote and update cache
- **Cache Fallback**: Uses cached code if remote fetch fails

## 使用场景 / Use Cases

### 场景 1: 共享组件库 / Scenario 1: Shared Component Library

多个项目共享同一套组件，可以将组件代码存储在 Git 仓库中，各个项目通过远程地址引用：

Multiple projects share the same set of components. Store component code in a Git repository and reference it via remote URLs:

```
代码地址: https://github.com/myorg/shared-components
代码分支: main
代码路径: src/components/DataTable.tsx
```

### 场景 2: CDN 分发 / Scenario 2: CDN Distribution

将组件代码发布到 CDN，通过 CDN 地址快速加载：

Publish component code to CDN for fast loading:

```
代码地址: https://cdn.myorg.com/components/v1.0.0/Chart.js
```

### 场景 3: 版本管理 / Scenario 3: Version Management

通过 Git 分支管理不同版本的组件：

Manage different versions of components through Git branches:

```
代码地址: https://github.com/myorg/components
代码分支: v1.0.0  (稳定版本)
代码分支: develop (开发版本)
```

## 注意事项 / Notes

1. **网络访问 / Network Access**: 确保服务器可以访问配置的远程地址
2. **代码格式 / Code Format**: 远程代码应该是有效的 TypeScript/React 代码
3. **安全性 / Security**: 只从可信的远程地址获取代码
4. **缓存策略 / Cache Strategy**: 如果需要立即获取最新代码，可以通过 `syncRemoteCode` API 手动刷新缓存

1. **Network Access**: Ensure the server can access the configured remote URL
2. **Code Format**: Remote code should be valid TypeScript/React code
3. **Security**: Only fetch code from trusted remote sources
4. **Cache Strategy**: To get the latest code immediately, manually refresh cache via `syncRemoteCode` API

## 故障排查 / Troubleshooting

### 问题: 无法获取远程代码 / Issue: Cannot fetch remote code

**可能原因 / Possible Causes:**
- 网络连接问题 / Network connectivity issues
- URL 格式错误 / Incorrect URL format
- 远程服务器不可访问 / Remote server unavailable

**解决方案 / Solutions:**
- 检查网络连接 / Check network connection
- 验证 URL 格式 / Verify URL format
- 检查远程服务器状态 / Check remote server status
- 查看服务器日志 / Check server logs

### 问题: Git 仓库路径错误 / Issue: Incorrect Git repository path

**解决方案 / Solutions:**
- 确保代码路径相对于仓库根目录 / Ensure code path is relative to repository root
- 检查文件是否存在于指定分支 / Verify file exists in specified branch
- 使用正确的文件扩展名 / Use correct file extension

## API 参考 / API Reference

### RemoteCodeFetcher Service

```typescript
// 获取远程代码
fetchCode(
  codeUrl: string,
  codeType: 'cdn' | 'git',  // 由前端指定类型
  codeBranch?: string,      // Git 分支名称（仅 Git 类型需要）
  codePath?: string         // Git 文件路径（仅 Git 类型需要）
): Promise<string>

// 检查缓存是否有效（已废弃，不再使用时间戳验证）
// 现在直接使用数据库中的缓存，不检查时间戳
isCacheValid(
  cache: { content: string; timestamp: number } | null,
  maxAge?: number
): boolean  // @deprecated 不再使用时间戳验证，直接使用缓存内容
```

