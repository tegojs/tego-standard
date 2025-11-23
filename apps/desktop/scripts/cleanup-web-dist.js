#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 获取脚本所在目录的父目录（apps/desktop）
const desktopDir = path.resolve(__dirname, '..');
const webDistTemp = path.resolve(desktopDir, 'web-dist-temp');

console.log('[cleanup-web-dist] Cleaning up temporary web-dist directory...');

// 清理临时目录
if (fs.existsSync(webDistTemp)) {
  try {
    execSync(`rm -rf "${webDistTemp}"`, { stdio: 'inherit' });
    console.log(`[cleanup-web-dist] ✓ Cleanup completed`);
  } catch (error) {
    console.warn(`[cleanup-web-dist] ⚠ Error during cleanup:`, error.message);
  }
} else {
  console.log(`[cleanup-web-dist] Temp directory does not exist, skipping cleanup`);
}
