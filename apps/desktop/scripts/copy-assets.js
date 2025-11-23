#!/usr/bin/env node

/**
 * 复制 Electron 资源文件到 app 目录
 * 包括 loading.html 和 i18n 语言包文件
 */

const fs = require('fs');
const path = require('path');

const electronDir = path.join(__dirname, '..', 'electron');
const appDir = path.join(__dirname, '..', 'app');
const i18nSourceDir = path.join(electronDir, 'i18n');
const i18nTargetDir = path.join(appDir, 'i18n');

// 确保 app 目录存在
if (!fs.existsSync(appDir)) {
  fs.mkdirSync(appDir, { recursive: true });
}

// 复制 loading.html
const loadingSource = path.join(electronDir, 'loading.html');
const loadingTarget = path.join(appDir, 'loading.html');

if (fs.existsSync(loadingSource)) {
  fs.copyFileSync(loadingSource, loadingTarget);
  console.log('✓ Copied loading.html');
} else {
  console.warn('⚠ loading.html not found');
}

// 确保 i18n 目标目录存在
if (!fs.existsSync(i18nTargetDir)) {
  fs.mkdirSync(i18nTargetDir, { recursive: true });
}

// 复制所有 JSON 语言包文件和 index.js
if (fs.existsSync(i18nSourceDir)) {
  const files = fs.readdirSync(i18nSourceDir);
  const jsonFiles = files.filter((file) => file.endsWith('.json'));
  const indexFile = files.find((file) => file === 'index.js');

  // 复制 index.js
  if (indexFile) {
    const indexSource = path.join(i18nSourceDir, 'index.js');
    const indexTarget = path.join(i18nTargetDir, 'index.js');
    fs.copyFileSync(indexSource, indexTarget);
    console.log('✓ Copied i18n/index.js');
  } else {
    console.warn('⚠ i18n/index.js not found');
  }

  // 复制 JSON 语言包文件
  if (jsonFiles.length === 0) {
    console.warn('⚠ No JSON language files found in i18n directory');
  } else {
    jsonFiles.forEach((file) => {
      const source = path.join(i18nSourceDir, file);
      const target = path.join(i18nTargetDir, file);
      fs.copyFileSync(source, target);
      console.log(`✓ Copied ${file}`);
    });
  }
} else {
  console.warn('⚠ i18n directory not found');
}

console.log('✓ Asset copy completed');
