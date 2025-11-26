# Tachybase Desktop Application

Mac 桌面应用，基于 Electron 构建。

## 📁 项目结构

```
apps/desktop/
├── electron/              # Electron 主进程代码
│   ├── main.ts           # 主进程入口
│   ├── preload.ts        # 预加载脚本
│   └── tsconfig.json     # TypeScript 配置
├── build/                # 构建资源
│   └── entitlements.mac.plist  # macOS 权限配置
├── electron-builder.config.js   # 打包配置
└── package.json          # 项目配置
```

## 🚀 快速开始

### 安装依赖

```bash
# 在项目根目录安装所有依赖（推荐）
pnpm install

# 或仅安装 desktop 依赖
cd apps/desktop
pnpm install
```

### 开发模式

**方式一：从项目根目录运行（推荐）**

```bash
# 在项目根目录
pnpm dev:desktop
# 或
pnpm desktop:dev
```

**方式二：从 desktop 目录运行**

```bash
cd apps/desktop
pnpm dev
```

这个命令会：
1. 启动 `apps/web` 的开发服务器（默认端口 31000，可通过 `WEB_PORT` 环境变量覆盖）
2. 等待服务器就绪后启动 Electron 窗口

**端口配置**：
- Web 开发服务器默认端口：`31000`（可通过 `WEB_PORT` 环境变量覆盖）
- 后端 API 服务器默认端口：`30000`（可通过 `APP_PORT` 环境变量覆盖，避免与常用端口冲突）
- **端口检查**：启动前会自动检查端口是否被占用，如果被占用会直接失败并提示
- 可通过环境变量自定义：`WEB_PORT=3000 APP_PORT=30000 pnpm desktop:dev`

### 构建和打包

**从项目根目录运行（推荐）**：

```bash
# 开发模式
pnpm desktop:dev

# 构建 Electron 主进程
pnpm desktop:build

# 打包为 Mac 应用
pnpm desktop:dist:mac

# 打包所有平台
pnpm desktop:dist
```

**从 desktop 目录运行**：

```bash
cd apps/desktop

# 1. 构建 Electron 主进程
pnpm build

# 2. 构建 Web 应用（会自动调用）
pnpm build:web

# 3. 打包为 Mac 应用
pnpm dist:mac
```

打包后的文件位于 `apps/desktop/release/` 目录。

## 📝 脚本说明

- `dev` - 开发模式（同时启动 Web 和 Electron）
- `build` - 构建 Electron 主进程
- `build:web` - 构建 Web 应用
- `electron` - 直接运行 Electron（需要先构建）
- `electron:dev` - 开发模式运行 Electron
- `pack` - 打包测试（不生成安装包）
- `dist` - 打包所有平台
- `dist:mac` - 仅打包 Mac 平台

## 🔧 配置说明

### 主进程配置 (`electron/main.ts`)

- **窗口大小**: 默认 1200x800，最小 800x600
- **开发环境**: 连接到 `apps/web` 的开发服务器
- **生产环境**: 加载 `apps/web/dist` 的构建产物

### 打包配置 (`electron-builder.config.js`)

- **应用 ID**: `com.tachybase.app`
- **产品名称**: `Tachybase`
- **支持架构**: x64 和 arm64（Apple Silicon）

## 📦 依赖关系

桌面应用依赖于 `apps/web` 的构建产物和后端服务器：

1. **开发环境**: 通过 HTTP 连接到 Web 开发服务器
2. **生产环境**: 
   - Web 构建产物通过 `electron-builder` 的 `extraResources` 自动从 `apps/web/dist` 包含
   - 后端服务器通过 `pnpm install --prod` 在临时目录准备，然后由 `electron-builder` 自动包含
   - 所有资源文件由 `electron-builder` 自动处理，无需手动复制

## 🎯 架构优势

✅ **关注点分离**: Web 和 Desktop 应用独立管理  
✅ **代码复用**: 共享 Web 应用的构建产物  
✅ **独立开发**: 可以独立开发和测试桌面功能  
✅ **清晰结构**: 符合 monorepo 最佳实践  

## 📋 日志查看

打包后的应用会自动将日志写入文件：

**macOS:**
```bash
~/Library/Logs/@tego/desktop/tachybase.log
```

**查看日志：**
```bash
# 实时查看日志
tail -f ~/Library/Logs/@tego/desktop/tachybase.log

# 查看最后 100 行
tail -n 100 ~/Library/Logs/@tego/desktop/tachybase.log
```

**从终端启动应用查看控制台日志：**
```bash
/Applications/Tachybase.app/Contents/MacOS/Tachybase
```

## ⚠️ 注意事项

1. **构建顺序**: 打包前需要先构建 Web 应用（`pnpm build:web`）
2. **路径配置**: 生产环境的路径会自动处理
3. **图标文件**: 需要准备 `build/icon.icns` 文件
4. **后端服务器**: 
   - 打包时会自动执行 `pnpm install --prod` 准备后端依赖
   - 生产环境会自动启动后端服务器（从应用包内的 `Resources/backend` 启动）
5. **自动化打包**: 使用 `electron-builder` 的 `files` 和 `extraResources` 配置自动处理所有资源文件，无需手动复制脚本

