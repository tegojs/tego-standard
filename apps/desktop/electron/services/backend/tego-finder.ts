import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { log } from '../../utils/logger';

/**
 * 查找 tego.js 路径
 */
export function findTegoJsPath(projectRoot: string): string | null {
  const tegoJsPath = path.join(projectRoot, 'node_modules', 'tego', 'bin', 'tego.js');

  if (fs.existsSync(tegoJsPath)) {
    return tegoJsPath;
  }

  // 检查 .pnpm 目录
  const pnpmPath = path.join(projectRoot, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmPath)) {
    try {
      const pnpmEntries = fs.readdirSync(pnpmPath);
      for (const entry of pnpmEntries) {
        if (entry.startsWith('tego@')) {
          const tegoPnpmPath = path.join(pnpmPath, entry, 'node_modules', 'tego', 'bin', 'tego.js');
          if (fs.existsSync(tegoPnpmPath)) {
            log(`[Electron] Found tego.js in .pnpm directory: ${tegoPnpmPath}`);
            return tegoPnpmPath;
          }
        }
      }
    } catch (err) {
      log(`[Electron] Error searching .pnpm directory: ${err}`, 'warn');
    }
  }

  return null;
}

/**
 * 查找 tego 可执行文件路径
 */
export function findTegoExecutable(projectRoot: string): { executablePath: string; args: string[] } | null {
  // 方法1: 尝试使用 tego start
  try {
    const tegoPath = execSync('command -v tego', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      shell: '/bin/bash',
    }).trim();
    if (tegoPath && fs.existsSync(tegoPath) && !tegoPath.includes('()')) {
      log(`[Electron] Using tego start: ${tegoPath}`);
      return { executablePath: tegoPath, args: ['start'] };
    }
  } catch (error) {
    // tego 不可用，继续尝试其他方法
  }

  return null;
}
