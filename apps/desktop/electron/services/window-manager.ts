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
  // 用于跟踪重定向，避免无限循环
  const redirectHistory = new Set<string>();

  // 添加响应头拦截器，确保 CORS 头正确设置
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // 如果是插件模块请求，确保 CORS 头正确设置
    if (details.url.includes('/static/plugins/') || details.url.includes('@tachybase/')) {
      const responseHeaders = {
        ...details.responseHeaders,
        'Access-Control-Allow-Origin': ['*'],
        'Access-Control-Allow-Methods': ['GET', 'HEAD', 'OPTIONS'],
        'Access-Control-Allow-Headers': ['Content-Type', 'Accept', 'Origin', 'X-Requested-With'],
        'Access-Control-Expose-Headers': ['Content-Length', 'Content-Type'],
      };
      callback({ responseHeaders });
      return;
    }
    callback({});
  });

  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;

    // 第一步：如果已经是 http://localhost:3000 的请求，直接放行（不需要任何处理）
    if (url.startsWith(`http://localhost:${appPort}/`) || url.startsWith(`http://127.0.0.1:${appPort}/`)) {
      callback({});
      return;
    }

    // 第二步：优先处理插件模块请求（必须在协议处理器之前）
    // 检查是否是插件模块路径（包含 /static/plugins/ 或 @tachybase/）
    if (url.includes('/static/plugins/') || url.includes('@tachybase/')) {
      // 提取路径部分，处理多种可能的格式：
      // - app://static/plugins/...
      // - app://index.html/static/plugins/...
      // - http://index.html/static/plugins/...
      let path = url;

      // 移除协议前缀（app:// 或 http://）
      path = path.replace(/^(app|http):\/\//, '');

      // 移除 index.html/ 前缀（如果存在）
      path = path.replace(/^index\.html\//, '');

      // 移除开头的斜杠（如果有）
      if (path.startsWith('/')) {
        path = path.slice(1);
      }

      // 确保路径以 static/plugins/ 开头
      if (path.startsWith('static/plugins/')) {
        // 保留查询参数（如果有）
        const redirectUrl = `http://localhost:${appPort}/${path}`;
        log(`[Electron] [Plugin] Redirecting: ${url} -> ${redirectUrl}`);
        callback({ redirectURL: redirectUrl });
        return;
      }
    }

    // 修复包含 index.html/ 的 app:// 路径（非插件路径）
    // 例如：app://index.html/api/... -> app://api/...
    // 注意：app://index.html/ 应该由协议处理器处理，不需要重定向
    if (url.startsWith('app://') && url.includes('index.html/')) {
      // 如果只是 app://index.html/（末尾只有斜杠），让协议处理器处理，不重定向
      // 协议处理器会将 app://index.html/ 正确处理为 index.html
      if (url === 'app://index.html/') {
        log(`[Electron] Allowing app://index.html/ to be handled by protocol handler`);
        callback({});
        return;
      }

      // 避免无限重定向：如果 URL 已经在重定向历史中，直接允许请求
      if (redirectHistory.has(url)) {
        log(`[Electron] Avoiding redirect loop for ${url}, allowing request`);
        redirectHistory.clear(); // 清除历史，允许正常请求
        callback({});
        return;
      }

      // 移除 index.html/ 前缀（例如：app://index.html/api/... -> app://api/...）
      const fixedUrl = url.replace(/app:\/\/index\.html\//, 'app://');

      // 记录重定向历史
      redirectHistory.add(url);
      if (redirectHistory.size > 10) {
        // 限制历史大小，避免内存泄漏
        const first = redirectHistory.values().next().value;
        if (first) {
          redirectHistory.delete(first);
        }
      }

      log(`[Electron] Fixing path: ${url} -> ${fixedUrl}`);
      callback({ redirectURL: fixedUrl });
      return;
    }

    // 如果请求成功，清除重定向历史
    if (!url.includes('index.html/')) {
      redirectHistory.clear();
    }

    // 处理 WebSocket 请求（ws:// 协议）
    if (url.startsWith('ws://') && (url.includes('index.html') || needsRedirect(url))) {
      const redirectUrl = redirectApiUrl(url, appPort);
      log(`[Electron] Redirecting WebSocket request: ${url} -> ${redirectUrl}`);
      callback({ redirectURL: redirectUrl });
      return;
    }

    // 第三步：处理其他需要重定向的 API 请求（不包括插件模块，已在上面处理）
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
  // 在打包后的应用中，loading.html 在 app.asar/app/loading.html
  // 在开发环境中，loading.html 在 electron/loading.html
  const possiblePaths: string[] = [];

  if (app.isPackaged) {
    // 生产环境：尝试多个可能的路径
    const appPath = app.getAppPath();

    // 方法1: 尝试从 asar 中读取（Electron 可以直接读取 asar 中的文件）
    if (appPath.endsWith('.asar')) {
      possiblePaths.push(
        path.join(appPath, 'app', 'loading.html'), // app.asar/app/loading.html
      );
    }

    // 方法2: 尝试解包后的路径（如果 asarUnpack 生效）
    possiblePaths.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'app', 'loading.html'), // 解包后的路径
      path.join(process.resourcesPath, 'app', 'loading.html'), // 直接解包到 Resources/app
    );

    // 方法3: 使用 app:// 协议（通过协议处理器加载）
    // 这样可以确保能访问到 asar 中的文件
    const appProtocolPath = 'app://loading.html';
    log(`[Electron] Will try app:// protocol: ${appProtocolPath}`);
    // 先尝试文件路径，如果都失败，最后使用 app:// 协议
  } else {
    // 开发环境：在 electron 目录中查找
    possiblePaths.push(
      path.join(__dirname, '..', 'loading.html'), // electron/loading.html
      path.join(__dirname, 'loading.html'), // 备用路径
    );
  }

  log(`[Electron] Searching for loading.html in ${possiblePaths.length} possible paths...`);
  for (const possiblePath of possiblePaths) {
    log(`[Electron] Checking: ${possiblePath}`);
    try {
      // 直接尝试读取文件（因为 asar 中的文件 fs.existsSync 可能无法检测）
      fs.accessSync(possiblePath, fs.constants.F_OK);
      // 使用 file:// 协议，确保路径正确
      const fileUrl = `file://${possiblePath}`;
      log(`[Electron] ✓ Found loading.html at: ${possiblePath}`);
      return fileUrl;
    } catch (e) {
      // 文件不存在或无法访问，继续尝试下一个路径
      log(`[Electron]   - Not accessible: ${possiblePath}`);
    }
  }

  // 如果文件路径都找不到，尝试使用 app:// 协议（通过协议处理器加载）
  // 这样可以访问 asar 中的文件
  if (app.isPackaged) {
    log(`[Electron] Using app:// protocol to load loading.html`);
    return 'app://loading.html';
  }

  // 如果找不到，返回一个简单的 data URL
  log(`[Electron] ⚠ loading.html not found, using fallback data URL`, 'warn');
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

  // 在加载 loading 页面之前，确保窗口可见
  // 这样可以避免白屏，用户可以看到 loading 页面
  if (!window.isVisible()) {
    window.show();
    log(`[Electron] Window shown for loading page`);
  }

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
  // preload 路径：在编译后，__dirname 指向 app/services/ 目录
  // preload.js 在 app/ 目录下，需要向上查找
  let preloadPath: string;
  if (isDev) {
    // 开发环境：从 electron/services/ 目录向上找到 electron/preload.ts
    preloadPath = path.join(__dirname, '..', 'preload.js');
  } else {
    // 生产环境：preload 脚本在 asar 中
    // app.getAppPath() 在 asar 环境中返回 asar 文件路径（如 /path/to/app.asar）
    // preload.js 在 asar 内部的 app/preload.js
    const appPath = app.getAppPath();

    // 如果 appPath 以 .asar 结尾，说明在 asar 中，preload 路径应该是 app/preload.js
    // 如果不在 asar 中，直接使用 appPath/preload.js
    if (appPath.endsWith('.asar')) {
      // 在 asar 中：preload 路径应该是相对于 asar 根目录的 app/preload.js
      preloadPath = path.join(appPath, 'app', 'preload.js');
    } else {
      // 不在 asar 中：直接使用 appPath/preload.js
      preloadPath = path.join(appPath, 'preload.js');
    }

    log(`[Electron] Preload path: ${preloadPath} (appPath: ${appPath})`);

    // 验证文件是否存在
    if (!fs.existsSync(preloadPath)) {
      log(`[Electron] ⚠ Preload file not found at ${preloadPath}, trying alternative paths...`, 'warn');

      // 尝试其他可能的路径
      const alternatives = [
        path.join(appPath, 'preload.js'), // 如果 appPath 已经是 asar/app
        path.join(__dirname, '..', 'preload.js'), // 从 services 目录向上
        path.join(process.resourcesPath, 'app.asar', 'app', 'preload.js'), // 使用 process.resourcesPath
      ];

      for (const altPath of alternatives) {
        if (fs.existsSync(altPath)) {
          preloadPath = altPath;
          log(`[Electron] Using alternative preload path: ${preloadPath}`);
          break;
        }
      }

      if (!fs.existsSync(preloadPath)) {
        log(`[Electron] ❌ Preload file not found at any of the attempted paths`, 'error');
        log(`[Electron] Tried: ${[preloadPath, ...alternatives].join(', ')}`, 'error');
      }
    }
  }
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
    // 在生产环境中，立即显示窗口以显示 loading 页面，避免白屏
    // 在开发环境中，等待 ready-to-show 事件
    show: !isDev,
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

    // 窗口准备好后显示
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
      mainWindow?.webContents.openDevTools();
    });
  } else {
    // 生产环境：检查后端服务器是否已经在运行
    // 如果已经在运行，直接加载主应用；如果未运行，显示 loading 页面
    const appPort = parseInt(process.env.APP_PORT || '3000', 10);

    // 异步检查服务器状态（不阻塞窗口创建）
    checkBackendServer(appPort)
      .then((isRunning) => {
        const window = mainWindow;
        if (!window) {
          log(`[Electron] Window was closed before server check completed`, 'warn');
          return;
        }

        if (isRunning) {
          // 后端服务器已经在运行，直接加载主应用
          log(`[Electron] Backend server is already running, loading main application directly...`);
          window.loadURL(startUrl);
          handleProductionLoadErrors(window, startUrl);
        } else {
          // 后端服务器未运行，显示 loading 页面并等待服务器启动
          log(`[Electron] Backend server is not running, showing loading page...`);
          handleProductionServerWait(window, startUrl);
        }
      })
      .catch((error) => {
        // 检查失败，显示 loading 页面（保守策略）
        const window = mainWindow;
        if (!window) {
          log(`[Electron] Window was closed before server check completed`, 'warn');
          return;
        }
        log(`[Electron] Failed to check backend server status: ${error.message}, showing loading page...`, 'warn');
        handleProductionServerWait(window, startUrl);
      });

    // 窗口准备好后立即显示（不等待内容加载完成）
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
    });

    // 如果 ready-to-show 已经触发，立即显示
    if (mainWindow.webContents.isLoading() === false) {
      mainWindow.show();
    }
  }

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
