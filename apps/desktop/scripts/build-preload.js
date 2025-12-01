#!/usr/bin/env node

/**
 * Preload 脚本打包脚本
 * 使用 esbuild 将 preload.ts 及其依赖打包成单个文件
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const desktopDir = path.join(__dirname, '..');
const electronDir = path.join(desktopDir, 'electron');
const appDir = path.join(desktopDir, 'app');
const preloadEntry = path.join(electronDir, 'preload.ts');
const preloadOutputApp = path.join(appDir, 'preload.js');
const preloadOutputElectron = path.join(electronDir, 'preload.js');

// 确保输出目录存在
if (!fs.existsSync(appDir)) {
  fs.mkdirSync(appDir, { recursive: true });
}

async function buildPreload() {
  try {
    const isDev = process.env.NODE_ENV !== 'production';
    const outputPath = isDev ? preloadOutputElectron : preloadOutputApp;

    console.log('[build-preload] Building preload script...');
    console.log(`[build-preload] Entry: ${preloadEntry}`);
    console.log(`[build-preload] Output: ${outputPath}`);
    console.log(`[build-preload] Mode: ${isDev ? 'development' : 'production'}`);

    const result = await esbuild.build({
      entryPoints: [preloadEntry],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: outputPath,
      external: ['electron'],
      sourcemap: isDev,
      minify: !isDev,
      logLevel: 'info',
      // 确保所有本地文件都被打包，不保留相对路径
      // 只排除 electron（外部依赖）
      resolveExtensions: ['.ts', '.js', '.json'],
      // 确保所有相对路径导入都被内联
      treeShaking: true,
    });

    // 验证打包结果，确保没有相对路径导入
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf8');
      const relativeImportMatches = content.match(/require\(['"]\.\.?\/[^'"]+['"]\)/g);
      if (relativeImportMatches && relativeImportMatches.length > 0) {
        console.warn('[build-preload] ⚠ Warning: Found relative path imports in bundled file:');
        relativeImportMatches.forEach((match) => console.warn(`  - ${match}`));
      } else {
        console.log('[build-preload] ✓ Verified: No relative path imports in bundled file');
      }
    }

    console.log('[build-preload] ✓ Preload script built successfully');
  } catch (error) {
    console.error('[build-preload] ✗ Failed to build preload script:', error);
    process.exit(1);
  }
}

buildPreload();
