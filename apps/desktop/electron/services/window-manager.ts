import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

import { log } from '../utils/logger';
import { findWebDistIndexHtml } from '../utils/path-finder';
import { isApiRequest, needsRedirect, redirectApiUrl } from '../utils/url-redirector';
import { checkBackendServer } from './backend-server';

let mainWindow: BrowserWindow | null = null;

/**
 * 检查服务器是否就绪
 */
function checkServer(port: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(`http://localhost:${port}`, (res: http.IncomingMessage) => {
      resolve(res.statusCode === 200 || res.statusCode === 304);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * 设置 API 请求拦截器
 */
function setupApiRequestInterceptor(window: BrowserWindow, isDev: boolean): void {
  if (isDev) {
    return;
  }

  const appPort = process.env.APP_PORT || '3000';
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;

    // 修复包含 index.html/ 的 app:// 路径
    // 例如：app://index.html/static/plugins/... -> app://static/plugins/...
    if (url.startsWith('app://') && url.includes('index.html/')) {
      const fixedUrl = url.replace(/app:\/\/index\.html\//, 'app://');
      log(`[Electron] Fixing path: ${url} -> ${fixedUrl}`);
      callback({ redirectURL: fixedUrl });
      return;
    }

    if (isApiRequest(url) && needsRedirect(url)) {
      const redirectUrl = redirectApiUrl(url, appPort);
      log(`[Electron] Redirecting API request: ${url} -> ${redirectUrl}`);
      callback({ redirectURL: redirectUrl });
      return;
    }
    callback({});
  });
}

/**
 * 设置开发环境监控
 */
function setupDevMonitoring(window: BrowserWindow): void {
  window.webContents.on('did-start-loading', () => {
    log('[Electron] Page started loading');
  });

  window.webContents.on('did-stop-loading', () => {
    log('[Electron] Page stopped loading');
  });

  // 监听所有网络请求
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (isApiRequest(details.url)) {
      log(`[Electron] Request: ${details.method} ${details.url}`);
    }
    callback({});
  });

  // 监听请求响应
  window.webContents.session.webRequest.onCompleted((details) => {
    if (isApiRequest(details.url)) {
      log(`[Electron] Response: ${details.statusCode} ${details.method} ${details.url}`);
    }
  });

  // 监听请求失败
  window.webContents.session.webRequest.onErrorOccurred((details) => {
    if (details.error !== 'net::ERR_ABORTED') {
      log(`[Electron] Request error: ${details.error} for ${details.url}`, 'error');
    }
  });

  // 监听控制台消息
  window.webContents.on('console-message', (event, level, message) => {
    if (level === 2 || level === 3) {
      // error or warning
      log(`[Renderer ${level === 2 ? 'ERROR' : 'WARN'}]: ${message}`, level === 2 ? 'error' : 'warn');
    }
  });
}

/**
 * 获取启动 URL
 */
function getStartUrl(isDev: boolean): string {
  const webPort = process.env.WEB_PORT || '31000';

  if (isDev) {
    return `http://localhost:${webPort}`;
  }

  // 生产环境：使用自定义协议
  return `app://index.html`;
}

/**
 * 处理开发环境的服务器等待逻辑
 */
function handleDevServerWait(window: BrowserWindow, startUrl: string, webPort: string): void {
  let serverReady = false;
  let pageAttempted = false;
  let reloadTimer: NodeJS.Timeout | null = null;
  let lastServerCheck = false;

  const loadWhenReady = async (retries = 10) => {
    const isReady = await checkServer(webPort);
    if (isReady) {
      serverReady = true;
      lastServerCheck = true;
      log(`[Electron] Server is ready, loading ${startUrl}`);
      pageAttempted = true;
      window?.loadURL(startUrl);
    } else if (retries > 0) {
      log(`[Electron] Server not ready yet, retrying in 1 second... (${retries} retries left)`);
      setTimeout(() => loadWhenReady(retries - 1), 1000);
    } else {
      log(`[Electron] Server not ready after multiple retries, loading anyway...`, 'error');
      pageAttempted = true;
      window?.loadURL(startUrl);
    }
  };

  // 启动时等待服务器就绪
  loadWhenReady();

  // 定期检查服务器状态，如果服务器从不可用变为可用，则自动重载
  const startServerWatch = () => {
    if (reloadTimer) {
      clearInterval(reloadTimer);
    }
    reloadTimer = setInterval(async () => {
      const isReady = await checkServer(webPort);

      // 如果服务器从不可用变为可用，且页面已经尝试加载过，则重载
      if (isReady && !lastServerCheck && pageAttempted) {
        serverReady = true;
        lastServerCheck = true;
        log(`[Electron] Server is now ready (was not ready before), reloading page...`);
        window?.reload();
      } else if (isReady) {
        lastServerCheck = true;
        if (!serverReady) {
          serverReady = true;
        }
      } else {
        lastServerCheck = false;
      }
    }, 2000); // 每2秒检查一次
  };

  startServerWatch();

  // 页面加载完成监听
  window.webContents.on('did-finish-load', () => {
    log(`[Electron] Page loaded successfully: ${startUrl}`);
    if (serverReady) {
      log(`[Electron] Server and page are both ready`);
    }
  });

  // 页面加载失败监听
  window.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log(`[Electron] Page load failed: ${errorDescription} (code: ${errorCode})`, 'error');
  });

  // 窗口关闭时清理定时器
  window.on('closed', () => {
    if (reloadTimer) {
      clearInterval(reloadTimer);
      reloadTimer = null;
    }
  });
}

/**
 * 获取 loading 页面路径
 */
function getLoadingPagePath(): string {
  const possiblePaths = [
    path.join(__dirname, 'loading.html'),
    path.join(process.resourcesPath, 'app', 'loading.html'),
    path.join(app.getAppPath(), 'loading.html'),
  ];

  for (const possiblePath of possiblePaths) {
    if (fs.existsSync(possiblePath)) {
      // 使用 file:// 协议，确保路径正确
      return `file://${possiblePath}`;
    }
  }

  // 如果找不到，返回一个简单的 data URL
  return 'data:text/html;charset=utf-8,<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#667eea;color:#fff"><div style="text-align:center"><h1>Starting Service...</h1><p>Please wait</p></div></body></html>';
}

/**
 * 更新 loading 页面的进度
 */
function updateLoadingProgress(
  window: BrowserWindow,
  progress: number,
  statusKey: string,
  ready: boolean = false,
): void {
  // 转义状态键名中的特殊字符
  const escapedStatusKey = statusKey.replace(/'/g, "\\'").replace(/\n/g, ' ');

  window.webContents
    .executeJavaScript(
      `
    (function() {
      if (window.updateLoadingStatus) {
        // 如果 statusKey 是翻译键名（如 'status.ready'），需要先翻译
        let statusText = '${escapedStatusKey}';
        if (typeof window.t === 'function') {
          statusText = window.t('${escapedStatusKey}');
        }
        window.updateLoadingStatus(${progress}, statusText, ${ready});
      }
    })();
  `,
    )
    .catch(() => {
      // 忽略错误，loading 页面可能还未加载完成
    });
}

/**
 * 处理生产环境的服务器等待逻辑
 */
function handleProductionServerWait(window: BrowserWindow, startUrl: string): void {
  const appPort = parseInt(process.env.APP_PORT || '3000', 10);
  let checkCount = 0;
  let serverReady = false;
  const maxChecks = 60; // 最多检查 60 次（60 秒）

  // 先加载 loading 页面
  const loadingPath = getLoadingPagePath();
  log(`[Electron] Loading loading page: ${loadingPath}`);
  window.loadURL(loadingPath);

  // 等待 loading 页面加载完成
  window.webContents.once('did-finish-load', () => {
    log(`[Electron] Loading page loaded, starting server check...`);

    // 开始检查服务器状态
    const checkInterval = setInterval(async () => {
      checkCount++;

      // 计算进度（最多到 90%，等待服务器就绪）
      const progress = Math.min(10 + checkCount * 1.5, 90);
      // 状态键名，由 loading.html 自己翻译
      const statusKeys = ['status.checking', 'status.waiting', 'status.initializing', 'status.almostDone'];
      const statusIndex = Math.min(Math.floor(checkCount / 15), statusKeys.length - 1);
      const statusKey = statusKeys[statusIndex];

      // 更新进度（传递键名，让 loading.html 自己翻译）
      updateLoadingProgress(window, progress, statusKey);

      // 检查服务器是否就绪
      const isReady = await checkBackendServer(appPort);

      if (isReady && !serverReady) {
        serverReady = true;
        clearInterval(checkInterval);

        // 更新进度到 100%（传递状态键名）
        updateLoadingProgress(window, 100, 'status.ready', true);

        log(`[Electron] Backend server is ready, loading main application...`);

        // 等待一小段时间让用户看到 100% 进度
        setTimeout(() => {
          window.loadURL(startUrl);
          handleProductionLoadErrors(window, startUrl);
        }, 500);
      } else if (checkCount >= maxChecks) {
        // 超时，仍然加载应用（可能服务器启动较慢）
        clearInterval(checkInterval);
        log(`[Electron] Server check timeout, loading application anyway...`, 'warn');
        updateLoadingProgress(window, 100, 'status.ready', true);

        setTimeout(() => {
          window.loadURL(startUrl);
          handleProductionLoadErrors(window, startUrl);
        }, 500);
      }
    }, 1000); // 每秒检查一次
  });
}

/**
 * 处理生产环境的加载错误
 */
function handleProductionLoadErrors(window: BrowserWindow, startUrl: string): void {
  window.webContents.on('did-finish-load', () => {
    log(`[Electron] Page loaded successfully: ${startUrl}`);
  });

  window.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log(`[Electron] Failed to load: ${validatedURL}`, 'error');
    log(`[Electron] Error code: ${errorCode}, Description: ${errorDescription}`, 'error');

    // 检查是否是文件路径问题
    if (errorCode === -3 || errorDescription.includes('ERR_FILE_NOT_FOUND')) {
      log(`[Electron] File not found. Checking resources path: ${process.resourcesPath}`, 'error');
      log(`[Electron] Expected web-dist at: ${path.join(process.resourcesPath, 'web-dist/index.html')}`, 'error');

      // 列出 Resources 目录内容以便调试
      try {
        const resourcesContents = fs.readdirSync(process.resourcesPath);
        log(`[Electron] Contents of Resources directory: ${JSON.stringify(resourcesContents)}`, 'error');
      } catch (e) {
        log(`[Electron] Failed to read Resources directory: ${e}`, 'error');
      }
    }
  });
}

/**
 * 创建应用窗口
 */
export function createWindow(isDev: boolean): BrowserWindow {
  // 创建浏览器窗口
  // preload 路径：在编译后，__dirname 指向 app/ 目录，preload.js 也在同一目录
  const preloadPath = path.join(__dirname, 'preload.js');
  mainWindow = new BrowserWindow({
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
    show: false, // 先不显示，等加载完成后再显示
  });

  // 设置 API 请求拦截器
  setupApiRequestInterceptor(mainWindow, isDev);

  // 开发环境下，添加详细的网络请求日志
  if (isDev) {
    setupDevMonitoring(mainWindow);
  }

  // 获取启动 URL
  const startUrl = getStartUrl(isDev);
  const webPort = process.env.WEB_PORT || '31000';

  log(`[Electron] Loading URL: ${startUrl}`);
  log(`[Electron] Environment: ${isDev ? 'development' : 'production'}`);
  log(`[Electron] WEB_PORT: ${process.env.WEB_PORT || 'not set'}`);
  if (!isDev) {
    log(`[Electron] Resources path: ${process.resourcesPath}`);

    // 验证 web-dist 路径
    const webDistPath = findWebDistIndexHtml();
    if (webDistPath) {
      log(`[Electron] ✓ Web dist found at: ${webDistPath}`);
    } else {
      log(`[Electron] ✗ Web dist not found`, 'error');
      const possiblePaths = [
        path.join(process.resourcesPath, 'web-dist', 'index.html'),
        path.join(__dirname, '..', 'web-dist', 'index.html'),
        path.join(app.getAppPath(), 'web-dist', 'index.html'),
      ];
      possiblePaths.forEach((p) => log(`[Electron]   - ${p}`, 'error'));
    }
  }

  // 开发环境下，等待服务器就绪后再加载
  if (isDev) {
    handleDevServerWait(mainWindow, startUrl, webPort);
  } else {
    // 生产环境：先显示 loading 页面，检查后端服务器状态
    handleProductionServerWait(mainWindow, startUrl);
  }

  // 窗口准备好后显示
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();

    // 开发环境下打开开发者工具
    if (isDev) {
      mainWindow?.webContents.openDevTools();
    }
  });

  // 处理窗口关闭
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 处理外部链接
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 阻止导航到外部 URL（仅在生产环境）
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

/**
 * 获取主窗口
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
