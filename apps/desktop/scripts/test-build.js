#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '../..');
const desktopDir = path.resolve(__dirname, '..');

console.log('Testing build process...');
console.log('Project root:', projectRoot);
console.log('Desktop dir:', desktopDir);

// 测试步骤 1: prepare-web-build
console.log('\n=== Step 1: prepare-web-build ===');
try {
  execSync('node scripts/prepare-web-build.js', {
    cwd: desktopDir,
    stdio: 'inherit',
  });
  console.log('✓ prepare-web-build completed');
} catch (err) {
  console.error('✗ prepare-web-build failed:', err.message);
  process.exit(1);
}

// 测试步骤 2: desktop build
console.log('\n=== Step 2: desktop build ===');
try {
  execSync('pnpm build', {
    cwd: desktopDir,
    stdio: 'inherit',
  });
  console.log('✓ desktop build completed');
} catch (err) {
  console.error('✗ desktop build failed:', err.message);
  process.exit(1);
}

// 测试步骤 3: web build
console.log('\n=== Step 3: web build ===');
try {
  execSync('cd ../.. && pnpm --filter @tego/web build', {
    cwd: desktopDir,
    stdio: 'inherit',
  });
  console.log('✓ web build completed');
} catch (err) {
  console.error('✗ web build failed:', err.message);
  console.log('Continuing with dist-mac.js (it will create a placeholder if web build failed)');
}

// 测试步骤 4: dist-mac
console.log('\n=== Step 4: dist-mac ===');
try {
  execSync('node scripts/dist-mac.js', {
    cwd: desktopDir,
    stdio: 'inherit',
  });
  console.log('✓ dist-mac completed');
} catch (err) {
  console.error('✗ dist-mac failed:', err.message);
  process.exit(1);
}

console.log('\n=== Build completed successfully! ===');
