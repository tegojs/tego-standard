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

    log('[Electron] App is ready');

    // 注册自定义协议（必须在创建窗口之前）
    registerCustomProtocol(isDev);

    // 设置应用名称（覆盖 package.json 中的 name）
    // 这样 app.getName() 会返回正确的名称
    if (app.getName() === '@tego/desktop') {
      app.setName('Tachybase');
    }

    // 在生产环境中，自动启动后端服务器
    if (!isDev) {
      try {
        await startBackendServer();
      } catch (error: any) {
        log(`[Electron] ⚠ Failed to start backend server: ${error.message}`, 'error');
        log(`[Electron] Application will continue, but API requests may fail.`, 'warn');
        log(`[Electron] Please ensure the backend server is running on port 3000`, 'warn');
        // 继续启动应用，即使后端服务器启动失败
      }
    }

    createWindow(isDev);
    createMenu();

    app.on('activate', () => {
      // macOS 上，当点击 dock 图标且没有其他窗口打开时，重新创建窗口
      if (BrowserWindow.getAllWindows().length === 0) {
        log('[Electron] App activated, creating new window');
        createWindow(isDev);
      }
    });
  })
  .catch((error) => {
    log(`[Electron] Failed to initialize app: ${error.message}\n${error.stack}`, 'error');
    app.quit();
  });

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出时关闭日志文件和停止后端服务器
app.on('before-quit', () => {
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
