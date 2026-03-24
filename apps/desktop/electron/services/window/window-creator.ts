import * as fs from 'node:fs';
import * as path from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

import { getWebPort } from '../../utils/config';
import { log } from '../../utils/logger';
import { findWebDistIndexHtml } from '../../utils/path-finder';
import { setupDevMonitoring } from '../interceptors/dev-monitoring';
import { setupApiRequestInterceptor } from '../interceptors/request-interceptor';
import { handleDevServerWait, handleProductionServerWait } from './server-waiter';

/**
 * 获取启动 URL
 */
function getStartUrl(isDev: boolean): string {
  const webPort = getWebPort();
  return isDev ? `http://localhost:${webPort}` : `app://index.html`;
}

/**
 * 查找 preload 脚本路径
 */
function findPreloadPath(isDev: boolean): string {
  let preloadPath: string;

  if (isDev) {
    preloadPath = path.join(__dirname, '..', '..', 'preload.js');
  } else {
    const appPath = app.getAppPath();

    if (appPath.endsWith('.asar')) {
      preloadPath = path.join(appPath, 'app', 'preload.js');
    } else {
      preloadPath = path.join(appPath, 'preload.js');
    }

    log(`[Electron] Preload path: ${preloadPath} (appPath: ${appPath})`);

    if (!fs.existsSync(preloadPath)) {
      log(`[Electron] ⚠ Preload file not found at ${preloadPath}, trying alternative paths...`, 'warn');

      const alternatives = [
        path.join(appPath, 'preload.js'),
        path.join(__dirname, '..', '..', 'preload.js'),
        path.join(process.resourcesPath, 'app.asar', 'app', 'preload.js'),
      ];

      for (const altPath of alternatives) {
        if (fs.existsSync(altPath)) {
          preloadPath = altPath;
          log(`[Electron] Using alternative preload path: ${preloadPath}`);
          break;
        }
      }

      if (!fs.existsSync(preloadPath)) {
        const errorMsg = `Preload file not found at any of the attempted paths. Tried: ${[preloadPath, ...alternatives].join(', ')}`;
        log(`[Electron] ❌ ${errorMsg}`, 'error');
        throw new Error(errorMsg);
      }
    }
  }

  return preloadPath;
}

/**
 * 创建应用窗口
 */
export function createWindow(isDev: boolean): BrowserWindow {
  const preloadPath = findPreloadPath(isDev);

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'default' : 'default',
    frame: true,
    show: !isDev,
  });

  setupApiRequestInterceptor(mainWindow, isDev);

  if (isDev) {
    setupDevMonitoring(mainWindow);
  }

  const startUrl = getStartUrl(isDev);
  const webPort = getWebPort();

  log(`[Electron] Loading URL: ${startUrl}`);
  log(`[Electron] Environment: ${isDev ? 'development' : 'production'}`);
  log(`[Electron] WEB_PORT: ${process.env.WEB_PORT || 'not set'}`);

  if (!isDev) {
    log(`[Electron] Resources path: ${process.resourcesPath}`);
    const webDistPath = findWebDistIndexHtml();
    if (webDistPath) {
      log(`[Electron] ✓ Web dist found at: ${webDistPath}`);
    } else {
      log(`[Electron] ✗ Web dist not found`, 'error');
      const possiblePaths = [
        path.join(process.resourcesPath, 'web-dist', 'index.html'),
        path.join(__dirname, '..', '..', 'web-dist', 'index.html'),
        path.join(app.getAppPath(), 'web-dist', 'index.html'),
      ];
      possiblePaths.forEach((p) => log(`[Electron]   - ${p}`, 'error'));
    }
  }

  if (isDev) {
    handleDevServerWait(mainWindow, startUrl, webPort);
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
      mainWindow?.webContents.openDevTools();
    });
  } else {
    // 生产环境始终先走 loading 轮询：main.ts 中 startBackendServer 在 createWindow 之后异步执行，
    // 若此处因「端口上已有进程」误判就绪而直接进主界面，会与真实启动顺序竞态，导致首屏 API 仍 503。
    log(`[Electron] Production: loading page first, waiting until app:getLang succeeds...`);
    handleProductionServerWait(mainWindow, startUrl);

    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
    });

    if (mainWindow.webContents.isLoading() === false) {
      mainWindow.show();
    }
  }

  mainWindow.on('closed', () => {
    // 窗口关闭处理由 window-manager.ts 统一管理
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!isDev) {
    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
      try {
        const parsedUrl = new URL(navigationUrl);
        const startUrlObj = new URL(startUrl);
        if (parsedUrl.origin !== startUrlObj.origin) {
          event.preventDefault();
          shell.openExternal(navigationUrl);
        }
      } catch {
        // 如果 URL 解析失败，允许导航
      }
    });
  }

  return mainWindow;
}
