import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import { BrowserWindow } from 'electron';

import { getAppPortNumber } from '../../utils/config';
import { log } from '../../utils/logger';
import { checkBackendServer } from '../backend-server';
import { getLoadingPagePath } from './loading-handler';

/**
 * 检查服务器是否就绪
 */
function checkServer(port: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(`http://localhost:${port}`, (res: http.IncomingMessage) => {
      res.on('data', () => {});
      res.on('end', () => {
        req.destroy();
        resolve(res.statusCode === 200 || res.statusCode === 304);
      });
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
 * 处理开发环境的服务器等待逻辑
 */
export function handleDevServerWait(window: BrowserWindow, startUrl: string, webPort: string): void {
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

  loadWhenReady();

  const startServerWatch = () => {
    if (reloadTimer) {
      clearInterval(reloadTimer);
    }
    reloadTimer = setInterval(async () => {
      const isReady = await checkServer(webPort);

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
    }, 2000);
  };

  startServerWatch();

  const onDidFinishLoad = () => {
    log(`[Electron] Page loaded successfully: ${startUrl}`);
    if (serverReady) {
      log(`[Electron] Server and page are both ready`);
    }
  };

  const onDidFailLoad = (event: Electron.Event, errorCode: number, errorDescription: string) => {
    log(`[Electron] Page load failed: ${errorDescription} (code: ${errorCode})`, 'error');
  };

  window.webContents.on('did-finish-load', onDidFinishLoad);
  window.webContents.on('did-fail-load', onDidFailLoad);

  window.on('close', () => {
    if (reloadTimer) {
      clearInterval(reloadTimer);
      reloadTimer = null;
    }
    if (window.webContents && !window.webContents.isDestroyed()) {
      window.webContents.removeListener('did-finish-load', onDidFinishLoad);
      window.webContents.removeListener('did-fail-load', onDidFailLoad);
    }
  });
}

/**
 * 更新 loading 页面的进度
 */
export function updateLoadingProgress(
  window: BrowserWindow,
  progress: number,
  statusKey: string,
  ready: boolean = false,
): void {
  const escapedStatusKey = statusKey.replace(/'/g, "\\'").replace(/\n/g, ' ');

  window.webContents
    .executeJavaScript(
      `
    (function() {
      if (window.updateLoadingStatus) {
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
      // 忽略错误
    });
}

/**
 * 处理生产环境的服务器等待逻辑
 */
export function handleProductionServerWait(window: BrowserWindow, startUrl: string): void {
  const appPort = getAppPortNumber();
  let checkCount = 0;
  let serverReady = false;
  const maxChecks = 60;

  const loadingPath = getLoadingPagePath();
  log(`[Electron] Loading loading page: ${loadingPath}`);

  if (!window.isVisible()) {
    window.show();
    log(`[Electron] Window shown for loading page`);
  }

  window.loadURL(loadingPath);

  window.webContents.once('did-finish-load', () => {
    log(`[Electron] Loading page loaded, starting server check...`);

    const checkInterval = setInterval(async () => {
      checkCount++;
      const progress = Math.min(10 + checkCount * 1.5, 90);
      const statusKeys = ['status.checking', 'status.waiting', 'status.initializing', 'status.almostDone'];
      const statusIndex = Math.min(Math.floor(checkCount / 15), statusKeys.length - 1);
      const statusKey = statusKeys[statusIndex];

      updateLoadingProgress(window, progress, statusKey);

      const isReady = await checkBackendServer(appPort);

      if (isReady && !serverReady) {
        serverReady = true;
        clearInterval(checkInterval);
        updateLoadingProgress(window, 100, 'status.ready', true);
        log(`[Electron] Backend server is ready, loading main application...`);

        setTimeout(() => {
          window.loadURL(startUrl);
          handleProductionLoadErrors(window, startUrl);
        }, 500);
      } else if (checkCount >= maxChecks) {
        clearInterval(checkInterval);
        log(`[Electron] Server check timeout, loading application anyway...`, 'warn');
        updateLoadingProgress(window, 100, 'status.ready', true);

        setTimeout(() => {
          window.loadURL(startUrl);
          handleProductionLoadErrors(window, startUrl);
        }, 500);
      }
    }, 1000);
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

    if (errorCode === -3 || errorDescription.includes('ERR_FILE_NOT_FOUND')) {
      log(`[Electron] File not found. Checking resources path: ${process.resourcesPath}`, 'error');
      log(`[Electron] Expected web-dist at: ${path.join(process.resourcesPath, 'web-dist/index.html')}`, 'error');

      try {
        const resourcesContents = fs.readdirSync(process.resourcesPath);
        log(`[Electron] Contents of Resources directory: ${JSON.stringify(resourcesContents)}`, 'error');
      } catch (e) {
        log(`[Electron] Failed to read Resources directory: ${e}`, 'error');
      }
    }
  });
}
