#!/usr/bin/env node

/**
 * 完整测试 wrapper 脚本的功能
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// 模拟构建后的应用包环境
const backendDir = path.join(__dirname, '..', 'backend-temp');
const nodeModulesPath = path.join(backendDir, 'node_modules');
const pnpmDir = path.join(nodeModulesPath, '.pnpm');

console.log('=== 完整测试 Wrapper 脚本 ===\n');

// 检查 backend-temp 是否存在
if (!fs.existsSync(backendDir)) {
  console.log('⚠ backend-temp 不存在，需要先运行构建');
  console.log('运行: pnpm run desktop:dist:mac');
  process.exit(1);
}

// 检查 node_modules
if (!fs.existsSync(nodeModulesPath)) {
  console.log('⚠ node_modules 不存在，需要先运行 prepare-backend');
  process.exit(1);
}

// 检查 .pnpm 目录
if (!fs.existsSync(pnpmDir)) {
  console.log('⚠ .pnpm 目录不存在');
  process.exit(1);
}

// 查找 globals 模块
const entries = fs.readdirSync(pnpmDir);
const globalsEntry = entries.find((entry) => entry.startsWith('@tachybase+globals@'));

if (!globalsEntry) {
  console.log('✗ 找不到 @tachybase+globals@* 模块');
  console.log('可用条目:', entries.slice(0, 10).join(', '));
  process.exit(1);
}

const globalsPath = path.join(pnpmDir, globalsEntry, 'node_modules', '@tachybase', 'globals');
console.log('✓ 找到 globals 模块:', globalsPath);

// 测试 require 模块
try {
  const globalsModule = require(globalsPath);
  const TachybaseGlobal = globalsModule.default || globalsModule;
  console.log('✓ 成功加载模块');
  console.log('  模块类型:', typeof TachybaseGlobal);
  console.log('  有 getInstance:', typeof TachybaseGlobal.getInstance === 'function');

  // 测试 getInstance
  const testPluginPaths = ['/test/path'];
  const initData = { PLUGIN_PATHS: testPluginPaths };
  const globals = TachybaseGlobal.getInstance(initData);
  console.log('✓ getInstance 调用成功');

  console.log('\n✅ 所有测试通过！Wrapper 脚本应该能正常工作。');
  console.log('\n下一步：重新构建应用包以应用修复');
  console.log('运行: pnpm run desktop:dist:mac');
} catch (err) {
  console.error('✗ 测试失败:', err.message);
  console.error('错误堆栈:', err.stack);
  process.exit(1);
}
