import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { log } from '../../utils/logger';

/**
 * 查找 Node.js 可执行文件路径
 */
export function findNodePath(): string | null {
  // 优先使用应用包中的 node
  const bundledNodePath = path.join(process.resourcesPath, 'node');
  if (fs.existsSync(bundledNodePath)) {
    log(`[Electron] Found bundled node at: ${bundledNodePath}`);
    return bundledNodePath;
  }

  // 从系统 PATH 查找
  const home = process.env.HOME || '';
  const searchPaths = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    '/usr/local/opt/node/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
  ].filter(Boolean);

  // 从常见路径直接查找
  for (const searchPath of searchPaths) {
    const possibleNode = path.join(searchPath, 'node');
    if (fs.existsSync(possibleNode)) {
      log(`[Electron] Found system node at: ${possibleNode}`);
      return possibleNode;
    }
  }

  // 查找 nvm 安装的 node
  if (home) {
    const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmVersionsDir)) {
      try {
        const versions = fs.readdirSync(nvmVersionsDir);
        const sortedVersions = versions.sort((a, b) => {
          return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
        });
        for (const version of sortedVersions) {
          const versionNodePath = path.join(nvmVersionsDir, version, 'bin', 'node');
          if (fs.existsSync(versionNodePath)) {
            log(`[Electron] Found nvm node at: ${versionNodePath}`);
            return versionNodePath;
          }
        }
      } catch (e) {
        log(`[Electron] Error reading nvm versions: ${e}`, 'warn');
      }
    }

    const nvmCurrentBin = path.join(home, '.nvm', 'current', 'bin', 'node');
    if (fs.existsSync(nvmCurrentBin)) {
      log(`[Electron] Found nvm current node at: ${nvmCurrentBin}`);
      return nvmCurrentBin;
    }
  }

  // 使用 command -v
  try {
    const envWithPath = {
      ...process.env,
      PATH: searchPaths.join(path.delimiter) + path.delimiter + (process.env.PATH || ''),
    };
    const foundNodePath = execSync('command -v node', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      shell: '/bin/bash',
      env: envWithPath,
    }).trim();
    if (foundNodePath && fs.existsSync(foundNodePath) && !foundNodePath.includes('()')) {
      log(`[Electron] Found system node at: ${foundNodePath}`);
      return foundNodePath;
    }
  } catch (error) {
    // 继续尝试其他方法
  }

  return null;
}
