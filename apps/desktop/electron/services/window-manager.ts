import { BrowserWindow } from 'electron';

import { createWindow as createWindowInternal } from './window/window-creator';

let mainWindow: BrowserWindow | null = null;

/**
 * 创建应用窗口
 */
export function createWindow(isDev: boolean): BrowserWindow {
  mainWindow = createWindowInternal(isDev);

  // 处理窗口关闭
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

/**
 * 获取主窗口
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
