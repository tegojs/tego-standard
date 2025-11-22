'use strict';
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (!desc || ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, 'default', { enumerable: true, value: v });
      }
    : function (o, v) {
        o['default'] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== 'default') __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
Object.defineProperty(exports, '__esModule', { value: true });
const electron_1 = require('electron');
const path = __importStar(require('path'));
const http = __importStar(require('http'));
// 判断是否为开发环境
const isDev = process.env.NODE_ENV === 'development' || !electron_1.app.isPackaged;
let mainWindow = null;
function createWindow() {
  // 创建浏览器窗口
  mainWindow = new electron_1.BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      // 允许加载本地资源
      allowRunningInsecureContent: false,
      // 启用实验性功能以支持某些 Web API
      experimentalFeatures: false,
    },
    // macOS 标题栏样式：使用标准标题栏，避免与内容重叠
    titleBarStyle: process.platform === 'darwin' ? 'default' : 'default',
    frame: true, // 显示窗口框架
    show: false, // 先不显示，等加载完成后再显示
  });
  // 开发环境下，添加详细的网络请求日志
  if (isDev) {
    mainWindow.webContents.on('did-start-loading', () => {
      console.log('[Electron] Page started loading');
    });
    mainWindow.webContents.on('did-stop-loading', () => {
      console.log('[Electron] Page stopped loading');
    });
    // 监听所有网络请求
    mainWindow.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      if (details.url.includes('/api/') || details.url.includes('/ws') || details.url.includes('/adapters/')) {
        console.log(`[Electron] Request: ${details.method} ${details.url}`);
      }
      callback({});
    });
    // 监听请求响应
    mainWindow.webContents.session.webRequest.onCompleted((details) => {
      if (details.url.includes('/api/') || details.url.includes('/ws') || details.url.includes('/adapters/')) {
        console.log(`[Electron] Response: ${details.statusCode} ${details.method} ${details.url}`);
      }
    });
    // 监听请求失败
    mainWindow.webContents.session.webRequest.onErrorOccurred((details) => {
      if (details.error !== 'net::ERR_ABORTED') {
        console.error(`[Electron] Request error: ${details.error} for ${details.url}`);
      }
    });
    // 监听控制台消息
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      if (level === 2 || level === 3) {
        // error or warning
        console.log(`[Renderer ${level === 2 ? 'ERROR' : 'WARN'}]: ${message}`);
      }
    });
  }
  // 加载应用
  // 开发环境：连接到 web 应用的开发服务器（默认端口 31000，可通过 WEB_PORT 环境变量覆盖）
  // 生产环境：加载 web 应用的构建产物（打包后位于 resources/web-dist）
  const webPort = process.env.WEB_PORT || '31000';
  const startUrl = isDev
    ? `http://localhost:${webPort}`
    : `file://${path.join(process.resourcesPath, 'web-dist/index.html')}`;
  console.log(`[Electron] Loading URL: ${startUrl}`);
  console.log(`[Electron] WEB_PORT: ${process.env.WEB_PORT || 'not set'}`);
  // 服务器状态检查函数
  const checkServer = async () => {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${webPort}`, (res) => {
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
  };
  // 开发环境下，等待服务器就绪后再加载
  if (isDev) {
    let serverReady = false;
    let pageAttempted = false; // 页面是否已经尝试加载过
    let reloadTimer = null;
    let lastServerCheck = false; // 上次检查时服务器是否就绪
    const loadWhenReady = async (retries = 10) => {
      const isReady = await checkServer();
      if (isReady) {
        serverReady = true;
        lastServerCheck = true;
        console.log(`[Electron] Server is ready, loading ${startUrl}`);
        pageAttempted = true;
        mainWindow?.loadURL(startUrl);
      } else if (retries > 0) {
        console.log(`[Electron] Server not ready yet, retrying in 1 second... (${retries} retries left)`);
        setTimeout(() => loadWhenReady(retries - 1), 1000);
      } else {
        console.error(`[Electron] Server not ready after multiple retries, loading anyway...`);
        pageAttempted = true;
        mainWindow?.loadURL(startUrl);
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
        const isReady = await checkServer();
        // 如果服务器从不可用变为可用，且页面已经尝试加载过，则重载
        if (isReady && !lastServerCheck && pageAttempted) {
          serverReady = true;
          lastServerCheck = true;
          console.log(`[Electron] Server is now ready (was not ready before), reloading page...`);
          mainWindow?.reload();
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
    mainWindow.webContents.on('did-finish-load', () => {
      console.log(`[Electron] Page loaded successfully: ${startUrl}`);
      // 如果服务器已经就绪，确保页面是最新的
      if (serverReady) {
        console.log(`[Electron] Server and page are both ready`);
      }
    });
    // 页面加载失败监听
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.log(`[Electron] Page load failed: ${errorDescription} (code: ${errorCode})`);
      // 如果是因为服务器未就绪导致的失败，会在服务器就绪后自动重载
    });
    // 窗口关闭时清理定时器
    mainWindow.on('closed', () => {
      if (reloadTimer) {
        clearInterval(reloadTimer);
        reloadTimer = null;
      }
    });
  } else {
    mainWindow.loadURL(startUrl);
  }
  // 添加加载错误处理（仅在非开发环境或特定错误时处理）
  // 开发环境下的失败会由服务器监控逻辑自动处理
  if (!isDev) {
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      console.error(`[Electron] Failed to load: ${validatedURL}`);
      console.error(`[Electron] Error code: ${errorCode}, Description: ${errorDescription}`);
    });
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
    electron_1.shell.openExternal(url);
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
          electron_1.shell.openExternal(navigationUrl);
        }
      } catch {
        // 如果 URL 解析失败，允许导航
      }
    });
  }
}
// 创建应用菜单（macOS）
function createMenu() {
  const template = [
    {
      label: electron_1.app.getName(),
      submenu: [
        { role: 'about', label: '关于' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '切换开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
  ];
  const menu = electron_1.Menu.buildFromTemplate(template);
  electron_1.Menu.setApplicationMenu(menu);
}
// 应用准备就绪
electron_1.app.whenReady().then(() => {
  createWindow();
  createMenu();
  electron_1.app.on('activate', () => {
    // macOS 上，当点击 dock 图标且没有其他窗口打开时，重新创建窗口
    if (electron_1.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
// 所有窗口关闭时退出（macOS 除外）
electron_1.app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    electron_1.app.quit();
  }
});
// 安全：防止新窗口创建
// 注意：新版本 Electron 中 new-window 事件已废弃，使用 setWindowOpenHandler 处理
electron_1.app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    electron_1.shell.openExternal(url);
    return { action: 'deny' };
  });
});
