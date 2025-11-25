#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getDesktopDir, getAppBundlePath, getDmgPath, getAppResourcesPath } = require('./utils/paths');
const { detectAppName, getPackageInfo } = require('./utils/app-detector');
const { createLogPrefix, success, warn, error, step } = require('./utils/logger');

const logPrefix = createLogPrefix('create-dmg');

// 检测应用信息
const appName = detectAppName();
const packageInfo = getPackageInfo();
const version = packageInfo.version || '1.0.0';
const appBundlePath = getAppBundlePath(appName);
const appPath = getAppResourcesPath(appName);
const dmgPath = getDmgPath(appName, version);
const blockmapPath = dmgPath + '.blockmap';
const desktopDir = getDesktopDir();
const tempDmgDir = path.resolve(desktopDir, 'temp-dmg');

step(logPrefix, 'Creating DMG');

// 删除旧的 DMG 和 blockmap
if (fs.existsSync(dmgPath)) {
  fs.unlinkSync(dmgPath);
  console.log(`${logPrefix} Removed old DMG`);
}
if (fs.existsSync(blockmapPath)) {
  fs.unlinkSync(blockmapPath);
  console.log(`${logPrefix} Removed old blockmap`);
}

try {
  // 创建临时目录
  if (fs.existsSync(tempDmgDir)) {
    execSync(`rm -rf "${tempDmgDir}"`, { stdio: 'inherit' });
  }
  fs.mkdirSync(tempDmgDir, { recursive: true });

  // 复制应用文件（此时 web-dist、node 和 backend 已经在应用包中）
  step(logPrefix, 'Copying app bundle to temp directory');
  execSync(`cp -R "${appBundlePath}" "${tempDmgDir}/"`, { stdio: 'inherit' });

  // 验证 web-dist、node 和 backend 是否在复制的应用包中
  const tempAppResources = path.join(tempDmgDir, `${appName}.app`, 'Contents', 'Resources');
  const tempWebDist = path.join(tempAppResources, 'web-dist');
  const tempNode = path.join(tempAppResources, 'node');
  const tempBackend = path.join(tempAppResources, 'backend');

  // 验证 web-dist（应该已经由 electron-builder 的 extraFiles 包含）
  if (!fs.existsSync(path.join(tempWebDist, 'index.html'))) {
    error(logPrefix, 'web-dist not found in copied app bundle');
    error(logPrefix, `Expected location: ${tempWebDist}`);
    process.exit(1);
  } else {
    success(logPrefix, 'Verified web-dist exists in copied app bundle');
  }

  // 确保 node 也在应用包中（由 copy-node-executable.js 复制）
  const nodeDestPath = path.join(appPath, 'node');
  if (!fs.existsSync(tempNode) && fs.existsSync(nodeDestPath)) {
    console.log(`${logPrefix} Copying node to temp app bundle...`);
    fs.copyFileSync(nodeDestPath, tempNode);
    fs.chmodSync(tempNode, 0o755);
    success(logPrefix, 'Node copied to temp app bundle');
  } else if (fs.existsSync(tempNode)) {
    success(logPrefix, 'Verified node exists in copied app bundle');
  }

  // 验证 backend（应该已经由 electron-builder 的 extraFiles 包含）
  if (!fs.existsSync(path.join(tempBackend, 'package.json'))) {
    error(logPrefix, 'Backend not found in copied app bundle');
    error(logPrefix, `Expected location: ${tempBackend}`);
    process.exit(1);
  } else {
    success(logPrefix, 'Verified backend exists in copied app bundle');
  }

  // 创建 Applications 链接（用于拖动安装）
  step(logPrefix, 'Creating Applications link');
  execSync(`ln -s /Applications "${tempDmgDir}/Applications"`, { stdio: 'inherit' });

  // 创建 DMG
  step(logPrefix, 'Creating DMG file');
  execSync(`hdiutil create -volname "Tachybase" -srcfolder "${tempDmgDir}" -ov -format UDZO "${dmgPath}"`, {
    stdio: 'inherit',
    cwd: desktopDir,
  });

  // 清理临时目录
  execSync(`rm -rf "${tempDmgDir}"`, { stdio: 'inherit' });

  // 验证 DMG 中的应用包是否包含 web-dist
  step(logPrefix, 'Verifying DMG contents');
  try {
    execSync(`hdiutil attach "${dmgPath}" -mountpoint /tmp/tachybase-dmg-verify -quiet`, { stdio: 'ignore' });
    const dmgAppResources = `/tmp/tachybase-dmg-verify/${appName}.app/Contents/Resources`;
    const dmgWebDist = `${dmgAppResources}/web-dist/index.html`;
    if (fs.existsSync(dmgWebDist)) {
      success(logPrefix, 'Verified web-dist exists in DMG');
    } else {
      warn(logPrefix, 'web-dist not found in DMG, but DMG was created');
    }
    execSync(`hdiutil detach /tmp/tachybase-dmg-verify -quiet`, { stdio: 'ignore' });
  } catch (verifyErr) {
    warn(logPrefix, `Could not verify DMG contents: ${verifyErr.message}`);
  }

  success(logPrefix, 'DMG created successfully with Applications link');
} catch (err) {
  error(logPrefix, `Failed to create DMG with hdiutil: ${err.message}`);
  error(logPrefix, `Error details: ${err}`);
  process.exit(1);
}
