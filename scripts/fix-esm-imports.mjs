#!/usr/bin/env node
/**
 * 构建后处理脚本：自动修复 ES 模块导入路径
 * - 为相对路径导入添加 .js 扩展名
 * - 修复目录导入（添加 /index.js）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

/**
 * 检查文件是否存在
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查目录是否存在且包含 index.js
 */
async function isDirectoryWithIndex(dirPath) {
  const indexPath = path.join(dirPath, 'index.js');
  return await fileExists(indexPath);
}

/**
 * 修复导入路径
 */
async function fixImportPath(importPath, currentFileDir) {
  // 跳过非相对路径导入（如 '@tego/server', 'lodash' 等）
  if (!importPath.startsWith('.')) {
    return importPath;
  }

  // 如果已经有扩展名，跳过
  if (importPath.match(/\.(js|ts|tsx|jsx|json)$/)) {
    return importPath;
  }

  const resolvedPath = path.resolve(currentFileDir, importPath);

  // 检查是否是目录
  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      // 目录导入，添加 /index.js
      return `${importPath}/index.js`;
    }
  } catch {
    // 路径不存在，继续检查文件
  }

  // 检查是否存在对应的 .js 文件（编译后的文件）
  const jsPath = `${resolvedPath}.js`;
  if (await fileExists(jsPath)) {
    return `${importPath}.js`;
  }

  // 对于相对路径导入，统一添加 .js 扩展名
  // 这是 ES 模块的要求，即使源文件是 .ts
  return `${importPath}.js`;
}

/**
 * 修复文件中的导入语句
 */
async function fixFileImports(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const dir = path.dirname(filePath);

    // 匹配 import/export from 语句中的相对路径
    // 匹配: import ... from './path' 或 export ... from './path'
    const importRegex = /(?:import|export)(?:\s+[^'"]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;

    let modified = false;
    const fixes = [];

    // 收集所有需要修复的导入
    const matches = Array.from(content.matchAll(importRegex));

    if (matches.length === 0) {
      return false;
    }

    // 应用修复（从后往前替换，避免位置偏移）
    let newContent = content;
    const replacements = [];

    for (const match of matches) {
      const importPath = match[1];

      // 跳过已经有扩展名的
      if (importPath.match(/\.(js|ts|tsx|jsx|json)$/)) {
        continue;
      }

      const fixedPath = await fixImportPath(importPath, dir);
      if (fixedPath !== importPath) {
        replacements.push({
          original: importPath,
          fixed: fixedPath,
          index: match.index,
          fullMatch: match[0],
        });
      }
    }

    if (replacements.length === 0) {
      return false;
    }

    // 从后往前替换，避免索引偏移
    replacements.sort((a, b) => b.index - a.index);

    for (const fix of replacements) {
      // 确定引号类型
      const quote = fix.fullMatch.includes("'") ? "'" : '"';
      // 替换导入路径
      const before = newContent.substring(0, fix.index);
      const after = newContent.substring(fix.index);
      const replaced = after.replace(
        new RegExp(`(['"])${fix.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['"])`),
        `$1${fix.fixed}$2`
      );
      newContent = before + replaced;
      modified = true;
    }

    if (modified) {
      await fs.writeFile(filePath, newContent, 'utf-8');
      console.log(`Fixed imports in: ${path.relative(rootDir, filePath)}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error.message);
    return false;
  }
}

/**
 * 递归处理目录
 */
async function processDirectory(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  let totalFixed = 0;

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    // 跳过 node_modules
    if (entry.name === 'node_modules') {
      continue;
    }

    if (entry.isDirectory()) {
      totalFixed += await processDirectory(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      // 只处理编译后的 JS 文件
      if (await fixFileImports(fullPath)) {
        totalFixed++;
      }
    }
  }

  return totalFixed;
}

/**
 * 主函数
 */
async function main() {
  console.log('🔧 Fixing ES module imports in compiled files...\n');

  const distDirs = [
    path.join(rootDir, 'packages'),
    path.join(rootDir, 'apps'),
  ];

  let totalFixed = 0;

  for (const distDir of distDirs) {
    if (await fileExists(distDir)) {
      // 查找所有 dist/lib 目录
      const packages = await fs.readdir(distDir, { withFileTypes: true });

      for (const pkg of packages) {
        if (!pkg.isDirectory()) continue;

        const libDir = path.join(distDir, pkg.name, 'lib');
        const distDir2 = path.join(distDir, pkg.name, 'dist');

        for (const buildDir of [libDir, distDir2]) {
          if (await fileExists(buildDir)) {
            console.log(`Processing: ${path.relative(rootDir, buildDir)}`);
            totalFixed += await processDirectory(buildDir);
          }
        }
      }
    }
  }

  console.log(`\n✅ Fixed ${totalFixed} files`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

