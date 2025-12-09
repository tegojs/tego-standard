import { BrowserWindow } from 'electron';

import { log } from '../../utils/logger';
import { isApiRequest } from '../../utils/url-redirector';

/**
 * 设置开发环境监控
 */
export function setupDevMonitoring(window: BrowserWindow): void {
  const onDidStartLoading = () => {
    log('[Electron] Page started loading');
  };

  const onDidStopLoading = () => {
    log('[Electron] Page stopped loading');
  };

  const onBeforeRequest = (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void,
  ) => {
    if (isApiRequest(details.url)) {
      log(`[Electron] Request: ${details.method} ${details.url}`);
    }
    callback({});
  };

  const onCompleted = (details: Electron.OnCompletedListenerDetails) => {
    if (isApiRequest(details.url)) {
      log(`[Electron] Response: ${details.statusCode} ${details.method} ${details.url}`);
    }
  };

  const onErrorOccurred = (details: Electron.OnErrorOccurredListenerDetails) => {
    if (details.error !== 'net::ERR_ABORTED') {
      log(`[Electron] Request error: ${details.error} for ${details.url}`, 'error');
    }
  };

  const onConsoleMessage = (event: Electron.Event, level: number, message: string) => {
    if (level === 2 || level === 3) {
      log(`[Renderer ${level === 2 ? 'ERROR' : 'WARN'}]: ${message}`, level === 2 ? 'error' : 'warn');
    }
  };

  // 添加监听器
  window.webContents.on('did-start-loading', onDidStartLoading);
  window.webContents.on('did-stop-loading', onDidStopLoading);
  window.webContents.session.webRequest.onBeforeRequest(onBeforeRequest);
  window.webContents.session.webRequest.onCompleted(onCompleted);
  window.webContents.session.webRequest.onErrorOccurred(onErrorOccurred);
  window.webContents.on('console-message', onConsoleMessage);

  // 窗口关闭时清理所有监听器
  window.once('close', () => {
    if (window.webContents && !window.webContents.isDestroyed()) {
      window.webContents.removeListener('did-start-loading', onDidStartLoading);
      window.webContents.removeListener('did-stop-loading', onDidStopLoading);
      window.webContents.removeListener('console-message', onConsoleMessage);

      try {
        window.webContents.session.webRequest.onBeforeRequest(null);
        window.webContents.session.webRequest.onCompleted(null);
        window.webContents.session.webRequest.onErrorOccurred(null);
      } catch (error) {
        log(`[Electron] Failed to remove webRequest listeners: ${error}`, 'warn');
      }
    }
  });
}
