#!/usr/bin/env node
/**
 * 临时修复迁移文件中的导入路径
 * 在运行 pnpm tbu 之前运行此脚本
 * 运行后可以使用 git checkout 恢复
 */

import fs, { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

/**
 * 修复文件中的导入路径
 */
async function fixFileImports(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const dir = path.dirname(filePath);

    // 匹配 import/export from 语句中的相对路径
    const importRegex = /(?:import|export)(?:\s+[^'"]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;

    let newContent = content;
    const matches = Array.from(content.matchAll(importRegex));
    const replacements = [];

    for (const match of matches) {
      const importPath = match[1];

      // 跳过已经有扩展名的
      if (importPath.match(/\.(js|ts|tsx|jsx|json)$/)) {
        continue;
      }

      // 检查是否是目录
      const resolvedPath = path.resolve(dir, importPath);
      let fixedPath = importPath;

      try {
        const stat = await fs.stat(resolvedPath);
        if (stat.isDirectory()) {
          // 目录导入，添加 /index.js
          fixedPath = `${importPath}/index.js`;
        } else {
          // 文件导入，添加 .js
          fixedPath = `${importPath}.js`;
        }
      } catch {
        // 路径不存在，统一添加 .js
        fixedPath = `${importPath}.js`;
      }

      if (fixedPath !== importPath) {
        replacements.push({
          original: importPath,
          fixed: fixedPath,
          index: match.index,
        });
      }
    }

    if (replacements.length === 0) {
      return false;
    }

    // 从后往前替换
    replacements.sort((a, b) => b.index - a.index);

    for (const fix of replacements) {
      const before = newContent.substring(0, fix.index);
      const after = newContent.substring(fix.index);
      const replaced = after.replace(
        new RegExp(`(['"])${fix.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['"])`),
        `$1${fix.fixed}$2`
      );
      newContent = before + replaced;
    }

    await fs.writeFile(filePath, newContent, 'utf-8');
    console.log(`Fixed: ${path.relative(rootDir, filePath)}`);
    return true;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error.message);
    return false;
  }
}

/**
 * 递归查找迁移文件
 */
async function findMigrationFiles(dir) {
  const files = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'lib') {
          files.push(...await findMigrationFiles(fullPath));
        }
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        if (dir.includes('migrations')) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    // 忽略无法访问的目录
  }

  return files;
}

/**
 * 主函数
 */
async function main() {
  console.log('🔧 Fixing ES module imports in migration files...\n');

  const packagesDir = path.join(rootDir, 'packages');
  const migrationFiles = await findMigrationFiles(packagesDir);

  let totalFixed = 0;
  for (const file of migrationFiles) {
    if (await fixFileImports(file)) {
      totalFixed++;
    }
  }

  console.log(`\n✅ Fixed ${totalFixed} migration files`);
  console.log('⚠️  Note: Run "pnpm tbu:restore" to restore files');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

