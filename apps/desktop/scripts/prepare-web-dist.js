#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 获取脚本所在目录的父目录（apps/desktop）
const desktopDir = path.resolve(__dirname, '..');
const webDistSrc = path.resolve(desktopDir, '../web/dist');
const webDistTemp = path.resolve(desktopDir, 'web-dist-temp');

console.log('[prepare-web-dist] Preparing web-dist for packaging...');
console.log(`[prepare-web-dist] Source: ${webDistSrc}`);
console.log(`[prepare-web-dist] Temp: ${webDistTemp}`);

// 检查源目录是否存在
if (!fs.existsSync(webDistSrc)) {
  console.error(`[prepare-web-dist] ✗ Web dist source not found at ${webDistSrc}`);
  process.exit(1);
}

// 清理临时目录
if (fs.existsSync(webDistTemp)) {
  console.log(`[prepare-web-dist] Removing existing temp directory`);
  execSync(`rm -rf "${webDistTemp}"`, { stdio: 'inherit' });
}

// 复制到临时目录
try {
  execSync(`cp -R "${webDistSrc}" "${webDistTemp}"`, { stdio: 'inherit' });

  // 验证复制结果
  const indexHtmlPath = path.join(webDistTemp, 'index.html');
  if (fs.existsSync(webDistTemp) && fs.existsSync(indexHtmlPath)) {
    console.log(`[prepare-web-dist] ✓ Web dist prepared successfully`);
  } else {
    console.error(`[prepare-web-dist] ✗ Failed to prepare web-dist`);
    process.exit(1);
  }
} catch (error) {
  console.error(`[prepare-web-dist] ✗ Error:`, error.message);
  process.exit(1);
}
