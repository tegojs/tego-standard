import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import { log } from '../../utils/logger';

/**
 * 获取 loading 页面路径
 */
export function getLoadingPagePath(): string {
  const possiblePaths: string[] = [];

  if (app.isPackaged) {
    const appPath = app.getAppPath();

    if (appPath.endsWith('.asar')) {
      possiblePaths.push(path.join(appPath, 'app', 'loading.html'));
    }

    possiblePaths.push(
      path.join(process.resourcesPath, 'app.asar.unpacked', 'app', 'loading.html'),
      path.join(process.resourcesPath, 'app', 'loading.html'),
    );
  } else {
    possiblePaths.push(path.join(__dirname, '..', '..', 'loading.html'), path.join(__dirname, '..', 'loading.html'));
  }

  log(`[Electron] Searching for loading.html in ${possiblePaths.length} possible paths...`);
  for (const possiblePath of possiblePaths) {
    log(`[Electron] Checking: ${possiblePath}`);
    try {
      fs.accessSync(possiblePath, fs.constants.F_OK);
      const fileUrl = `file://${possiblePath}`;
      log(`[Electron] ✓ Found loading.html at: ${possiblePath}`);
      return fileUrl;
    } catch (e) {
      log(`[Electron]   - Not accessible: ${possiblePath}`);
    }
  }

  if (app.isPackaged) {
    log(`[Electron] Using app:// protocol to load loading.html`);
    return 'app://loading.html';
  }

  log(`[Electron] ⚠ loading.html not found, using fallback data URL`, 'warn');
  return 'data:text/html;charset=utf-8,<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#667eea;color:#fff"><div style="text-align:center"><h1>Starting Service...</h1><p>Please wait</p></div></body></html>';
}
