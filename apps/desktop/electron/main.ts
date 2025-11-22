import { app, BrowserWindow, protocol, shell } from 'electron';

// 服务模块
import { startBackendServer, stopBackendServer } from './services/backend-server';
import { createMenu } from './services/menu-manager';
import { registerCustomProtocol } from './services/protocol-handler';
import { createWindow, getMainWindow } from './services/window-manager';
// 工具模块
import { closeLogFile, initLogFile, log, setupErrorHandlers } from './utils/logger';

// 判断是否为开发环境
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// 在应用启动时注册协议为标准协议（必须在 app.whenReady() 之前，在模块加载时执行）
// 这样自定义协议就能支持 localStorage 等 Web API
if (!isDev) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
  console.log('[Electron] Protocol "app" registered as privileged scheme');
}

// 设置全局错误处理
setupErrorHandlers();

// 应用准备就绪
app
  .whenReady()
  .then(async () => {
    // 初始化日志文件（在生产环境）
    initLogFile();

    // 记录启动信息（用于调试）
    log(`[Electron] App is ready`);
    log(`[Electron] App path: ${app.getAppPath()}`);
    log(`[Electron] Resources path: ${process.resourcesPath}`);
    log(`[Electron] Working directory: ${process.cwd()}`);
    log(`[Electron] Is packaged: ${app.isPackaged}`);
    log(`[Electron] NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);

    // 注册自定义协议（必须在创建窗口之前）
    registerCustomProtocol(isDev);

    // 设置应用名称（覆盖 package.json 中的 name）
    // 这样 app.getName() 会返回正确的名称
    if (app.getName() === '@tego/desktop') {
      app.setName('Tachybase');
    }

    // 先创建窗口并显示 loading 页面，让用户看到启动进度
    createWindow(isDev);
    createMenu();

    // 在生产环境中，在窗口显示后异步启动后端服务器
    // 这样用户可以在 loading 页面看到启动进度
    // 注意：无论从 Finder 还是命令行启动，都应该启动后端服务器
    if (!isDev) {
      log(`[Electron] Production mode detected, starting backend server...`);
      // 不等待后端服务器启动，让它在后台启动
      // loading 页面会检查服务器状态并更新进度
      startBackendServer().catch((error: any) => {
        log(`[Electron] ⚠ Failed to start backend server: ${error.message}`, 'error');
        log(`[Electron] Error stack: ${error.stack}`, 'error');
        log(`[Electron] Application will continue, but API requests may fail.`, 'warn');
        log(`[Electron] Please ensure the backend server is running on port 3000`, 'warn');
        // 继续运行，loading 页面会检测到服务器未启动并显示相应状态
      });
    } else {
      log(`[Electron] Development mode detected, backend server should be started separately`);
    }

    app.on('activate', async () => {
      // macOS 上，当点击 dock 图标且没有其他窗口打开时，重新创建窗口
      if (BrowserWindow.getAllWindows().length === 0) {
        log('[Electron] App activated, creating new window');
        createWindow(isDev);

        // 在生产环境中，检查后端服务器是否在运行
        // 如果不在运行，则启动它（可能因为窗口关闭时进程被终止）
        // 注意：createWindow 内部也会检查服务器状态并决定是否显示 loading 页面
        // 这里确保服务器在需要时启动（startBackendServer 内部会检查，如果已运行则跳过）
        if (!isDev) {
          log('[Electron] Ensuring backend server is running after window recreation...');
          startBackendServer().catch((error: any) => {
            log(`[Electron] ⚠ Failed to start backend server after activation: ${error.message}`, 'error');
            log(`[Electron] Error stack: ${error.stack}`, 'error');
            log(`[Electron] Application will continue, but API requests may fail.`, 'warn');
          });
        }
      }
    });
  })
  .catch((error) => {
    log(`[Electron] Failed to initialize app: ${error.message}\n${error.stack}`, 'error');
    app.quit();
  });

// 所有窗口关闭时退出（macOS 除外）
// 注意：在 macOS 上，点击窗口的关闭按钮（叉号）只会关闭窗口，不会退出应用
// 应用会继续在后台运行，后端服务器也会继续运行
// 只有从 Dock 右键菜单选择"退出"时，才会真正退出应用并触发 before-quit 事件
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  // macOS 上不退出，保持应用运行，后端服务器继续运行
});

// 应用退出时关闭日志文件和停止后端服务器
// 注意：这个事件只在应用真正退出时触发（比如从 Dock 退出，或非 macOS 系统上关闭所有窗口）
// 点击窗口的关闭按钮（macOS）不会触发此事件，后端服务器会继续运行
app.on('before-quit', () => {
  log('[Electron] App is quitting, stopping backend server...');
  // 停止后端服务器
  stopBackendServer();

  // 关闭日志文件
  closeLogFile();
});

// 安全：防止新窗口创建
// 注意：新版本 Electron 中 new-window 事件已废弃，使用 setWindowOpenHandler 处理
app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});
