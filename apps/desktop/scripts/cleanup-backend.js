#!/usr/bin/env node

const path = require('path');
const { getDesktopDir } = require('./utils/paths');
const { removeDirectory } = require('./utils/file-operations');
const { createLogPrefix, success, log } = require('./utils/logger');

const logPrefix = createLogPrefix('cleanup-backend');
const desktopDir = getDesktopDir();
const backendTemp = path.resolve(desktopDir, 'backend-temp');

console.log(`${logPrefix} Cleaning up temporary backend directory...`);

// 清理临时目录
if (require('fs').existsSync(backendTemp)) {
  try {
    removeDirectory(backendTemp, logPrefix);
    success(logPrefix, 'Cleanup completed');
  } catch (err) {
    console.warn(`${logPrefix} ⚠ Error during cleanup: ${err.message}`);
  }
} else {
  log(logPrefix, 'Temp directory does not exist, skipping cleanup');
}
