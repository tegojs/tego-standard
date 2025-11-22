#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 获取脚本所在目录的父目录（apps/desktop）
const desktopDir = path.resolve(__dirname, '..');
const webDistSrc = path.resolve(desktopDir, '../web/dist');

// 从 package.json 读取应用信息
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));

// 自动检测应用名称：扫描 dist/mac-arm64 目录查找 .app 文件
const macArm64Dir = path.resolve(desktopDir, 'dist/mac-arm64');
let appName = 'Tachybase'; // 默认值

if (fs.existsSync(macArm64Dir)) {
  const files = fs.readdirSync(macArm64Dir);
  const appBundle = files.find((file) => file.endsWith('.app'));
  if (appBundle) {
    appName = appBundle.replace('.app', '');
    console.log(`[copy-web-dist] Detected app name: ${appName}`);
  }
}

// 动态构建路径
const appPath = path.resolve(desktopDir, `dist/mac-arm64/${appName}.app/Contents/Resources`);
const webDistDest = path.join(appPath, 'web-dist');

console.log('[copy-web-dist] Copying web-dist to packaged app...');
console.log(`[copy-web-dist] Source: ${webDistSrc}`);
console.log(`[copy-web-dist] Destination: ${webDistDest}`);
console.log(`[copy-web-dist] App name: ${appName}`);

// 检查源目录是否存在
if (!fs.existsSync(webDistSrc)) {
  console.error(`[copy-web-dist] ✗ Web dist source not found at ${webDistSrc}`);
  process.exit(1);
}

// 检查目标目录是否存在
if (!fs.existsSync(appPath)) {
  console.error(`[copy-web-dist] ✗ App Resources directory not found at ${appPath}`);
  console.error(`[copy-web-dist] Make sure electron-builder has completed successfully`);
  process.exit(1);
}

// 如果目标目录已存在，先删除
if (fs.existsSync(webDistDest)) {
  console.log(`[copy-web-dist] Removing existing web-dist directory`);
  execSync(`rm -rf "${webDistDest}"`, { stdio: 'inherit' });
}

// 验证 web-dist 是否已经在应用包中（由 afterPack hook 复制）
console.log(`[copy-web-dist] Verifying web-dist in app bundle...`);
const verifyIndexHtml = path.join(webDistDest, 'index.html');
if (!fs.existsSync(verifyIndexHtml)) {
  console.log(`[copy-web-dist] web-dist not found, copying now...`);
  // 如果 afterPack hook 没有复制，手动复制
  try {
    execSync(`cp -R "${webDistSrc}" "${webDistDest}"`, { stdio: 'inherit' });
    if (!fs.existsSync(verifyIndexHtml)) {
      console.error(`[copy-web-dist] ✗ Failed to copy web-dist`);
      process.exit(1);
    }
    console.log(`[copy-web-dist] ✓ Web dist copied successfully`);
  } catch (error) {
    console.error(`[copy-web-dist] ✗ Error copying web-dist:`, error.message);
    process.exit(1);
  }
} else {
  console.log(`[copy-web-dist] ✓ Web dist already exists in app bundle (copied by afterPack hook)`);
}

// 重新生成 DMG（因为之前的 DMG 不包含 web-dist）
// 使用 electron-builder 重新生成 DMG，这样可以应用 dmg.contents 配置（包含 Applications 链接）
// 注意：electron-builder 会重新打包应用，但 afterPack hook 会自动复制 web-dist
console.log(`[copy-web-dist] Regenerating DMG with web-dist using electron-builder...`);
const version = packageJson.version || '1.0.0';
const dmgPath = path.resolve(desktopDir, `dist/${appName}-${version}-arm64.dmg`);
const blockmapPath = path.resolve(desktopDir, `dist/${appName}-${version}-arm64.dmg.blockmap`);

// 删除旧的 DMG 和 blockmap
if (fs.existsSync(dmgPath)) {
  fs.unlinkSync(dmgPath);
  console.log(`[copy-web-dist] Removed old DMG`);
}
if (fs.existsSync(blockmapPath)) {
  fs.unlinkSync(blockmapPath);
  console.log(`[copy-web-dist] Removed old blockmap`);
}

// 直接使用 hdiutil 创建 DMG，避免 electron-builder 重新打包导致 web-dist 丢失
// 这样可以确保 web-dist 在 DMG 中的应用包中
console.log(`[copy-web-dist] Creating DMG with hdiutil (ensuring web-dist is included)...`);
const appBundlePath = path.resolve(desktopDir, `dist/mac-arm64/${appName}.app`);
const tempDmgDir = path.resolve(desktopDir, 'temp-dmg');

try {
  // 创建临时目录
  if (fs.existsSync(tempDmgDir)) {
    execSync(`rm -rf "${tempDmgDir}"`, { stdio: 'inherit' });
  }
  fs.mkdirSync(tempDmgDir, { recursive: true });

  // 复制应用文件（此时 web-dist 已经在应用包中）
  console.log(`[copy-web-dist] Copying app bundle to temp directory...`);
  execSync(`cp -R "${appBundlePath}" "${tempDmgDir}/"`, { stdio: 'inherit' });

  // 验证 web-dist 是否在复制的应用包中
  const tempAppResources = path.join(tempDmgDir, `${appName}.app`, 'Contents', 'Resources');
  const tempWebDist = path.join(tempAppResources, 'web-dist');
  if (!fs.existsSync(path.join(tempWebDist, 'index.html'))) {
    console.log(`[copy-web-dist] web-dist not found in copied app bundle, copying now...`);
    execSync(`cp -R "${webDistSrc}" "${tempWebDist}"`, { stdio: 'inherit' });
  } else {
    console.log(`[copy-web-dist] ✓ Verified web-dist exists in copied app bundle`);
  }

  // 创建 Applications 链接（用于拖动安装）
  console.log(`[copy-web-dist] Creating Applications link...`);
  execSync(`ln -s /Applications "${tempDmgDir}/Applications"`, { stdio: 'inherit' });

  // 创建 DMG
  console.log(`[copy-web-dist] Creating DMG file...`);
  execSync(`hdiutil create -volname "Tachybase" -srcfolder "${tempDmgDir}" -ov -format UDZO "${dmgPath}"`, {
    stdio: 'inherit',
    cwd: desktopDir,
  });

  // 清理临时目录
  execSync(`rm -rf "${tempDmgDir}"`, { stdio: 'inherit' });

  // 验证 DMG 中的应用包是否包含 web-dist
  console.log(`[copy-web-dist] Verifying web-dist in DMG...`);
  try {
    execSync(`hdiutil attach "${dmgPath}" -mountpoint /tmp/tachybase-dmg-verify -quiet`, { stdio: 'ignore' });
    const dmgAppResources = `/tmp/tachybase-dmg-verify/${appName}.app/Contents/Resources`;
    const dmgWebDist = `${dmgAppResources}/web-dist/index.html`;
    if (fs.existsSync(dmgWebDist)) {
      console.log(`[copy-web-dist] ✓ Verified web-dist exists in DMG`);
    } else {
      console.warn(`[copy-web-dist] ⚠ web-dist not found in DMG, but DMG was created`);
    }
    execSync(`hdiutil detach /tmp/tachybase-dmg-verify -quiet`, { stdio: 'ignore' });
  } catch (verifyError) {
    console.warn(`[copy-web-dist] ⚠ Could not verify DMG contents: ${verifyError.message}`);
  }

  console.log(`[copy-web-dist] ✓ DMG created successfully with Applications link`);
} catch (hdiutilError) {
  console.error(`[copy-web-dist] ✗ Failed to create DMG with hdiutil:`, hdiutilError.message);
  console.error(`[copy-web-dist] Error details:`, hdiutilError);
  process.exit(1);
}
