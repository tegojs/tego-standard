import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { log } from '../../utils/logger';
import { findNodePath } from './node-finder';
import { findTegoJsPath } from './tego-finder';

/**
 * 确保应用已安装
 */
export async function ensureApplicationInstalled(
  projectRoot: string,
  executablePath: string,
  nodePathForEnv: string | null,
  env: Record<string, string>,
): Promise<void> {
  log(`[Electron] Checking if application is installed...`);

  const tegoJsPath = findTegoJsPath(projectRoot);
  if (!tegoJsPath) {
    log(`[Electron] ⚠ Could not find tego.js, skipping install check`, 'warn');
    return;
  }

  let nodePath: string | null = nodePathForEnv || null;

  if (!nodePath && executablePath && executablePath.includes('node') && !executablePath.includes('tego')) {
    nodePath = executablePath;
  }

  if (!nodePath) {
    nodePath = findNodePath();
  }

  if (!nodePath) {
    try {
      const foundNodePath = execSync('command -v node', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        shell: '/bin/bash',
        env,
      }).trim();
      if (foundNodePath && fs.existsSync(foundNodePath) && !foundNodePath.includes('()')) {
        nodePath = foundNodePath;
      }
    } catch (error) {
      // 忽略错误
    }
  }

  if (!nodePath) {
    log(`[Electron] ⚠ Could not find node path, skipping install check`, 'warn');
    return;
  }

  try {
    log(`[Electron] Running tego install to ensure application is installed...`);
    log(`[Electron] Database path: ${env.DB_STORAGE || 'not set'}`);
    log(`[Electron] Database dialect: ${env.DB_DIALECT || 'not set'}`);

    const installOutput = execSync(`${nodePath} ${tegoJsPath} install`, {
      cwd: projectRoot,
      env,
      stdio: 'pipe',
      timeout: 120000,
      encoding: 'utf8',
    });

    if (installOutput && installOutput.trim()) {
      log(`[Electron] Install output: ${installOutput.substring(0, 500)}`);
    }

    log(`[Electron] ✓ Application installation verified and database initialized`);
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    const errorOutput = error.stdout || error.stderr || '';

    log(`[Electron] ⚠ Install command failed: ${errorMessage}`, 'error');
    if (errorOutput) {
      log(`[Electron] Install error output: ${errorOutput.substring(0, 1000)}`, 'error');
    }

    if (errorMessage.includes('no such table') || errorMessage.includes('SQLITE_ERROR')) {
      log(`[Electron] ⚠ Database initialization error detected. This may be expected on first run.`, 'warn');
      log(`[Electron] The application will attempt to create tables during startup.`, 'warn');
    } else {
      log(`[Electron] ⚠ Install failed but continuing with server start...`, 'warn');
      log(`[Electron] If you encounter database errors, try running 'tego install' manually.`, 'warn');
    }
  }
}
