#!/usr/bin/env node

/**
 * 测试 wrapper 脚本的模块查找逻辑
 */

const path = require('path');
const fs = require('fs');

// 模拟 wrapper 脚本的环境
const backendDir = path.join(__dirname, '..', 'backend-temp');
const nodeModulesPath = path.join(backendDir, 'node_modules');

console.log('=== Testing Wrapper Script Module Resolution ===\n');
console.log('Backend dir:', backendDir);
console.log('Node modules path:', nodeModulesPath);
console.log('Node modules exists:', fs.existsSync(nodeModulesPath));

if (!fs.existsSync(nodeModulesPath)) {
  console.log('\n⚠ Backend-temp not found. Run build first: pnpm run desktop:dist:mac');
  process.exit(1);
}

const pnpmDir = path.join(nodeModulesPath, '.pnpm');
console.log('.pnpm dir exists:', fs.existsSync(pnpmDir));

if (fs.existsSync(pnpmDir)) {
  const entries = fs.readdirSync(pnpmDir);
  const globalsEntry = entries.find((entry) => entry.startsWith('@tachybase+globals@'));

  if (globalsEntry) {
    console.log('✓ Found globals entry:', globalsEntry);
    const globalsPath = path.join(pnpmDir, globalsEntry, 'node_modules', '@tachybase', 'globals');
    console.log('Globals path:', globalsPath);
    console.log('Globals path exists:', fs.existsSync(globalsPath));

    if (fs.existsSync(globalsPath)) {
      const packageJsonPath = path.join(globalsPath, 'package.json');
      console.log('package.json exists:', fs.existsSync(packageJsonPath));

      try {
        const TachybaseGlobal = require(globalsPath);
        console.log('✓ Successfully required @tachybase/globals');
        console.log('Module type:', typeof TachybaseGlobal);
        console.log('Module has getInstance:', typeof TachybaseGlobal.getInstance === 'function');

        // 测试设置 PLUGIN_PATHS
        const testPluginPaths = ['/test/path'];
        const initData = { PLUGIN_PATHS: testPluginPaths };
        const globals = TachybaseGlobal.getInstance(initData);
        console.log('✓ Successfully called getInstance with PLUGIN_PATHS');

        console.log('\n✅ All tests passed! Wrapper script should work correctly.');
      } catch (err) {
        console.error('✗ Failed to require module:', err.message);
        process.exit(1);
      }
    } else {
      console.error('✗ Globals path does not exist');
      process.exit(1);
    }
  } else {
    console.error('✗ Could not find @tachybase+globals@* in .pnpm directory');
    console.error('Available entries (first 10):', entries.slice(0, 10).join(', '));
    process.exit(1);
  }
} else {
  console.error('✗ .pnpm directory does not exist');
  process.exit(1);
}
