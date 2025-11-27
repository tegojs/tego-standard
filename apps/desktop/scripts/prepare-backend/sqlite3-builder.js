const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createLogPrefix, success, log, warn } = require('../utils/logger');

const logPrefix = createLogPrefix('prepare-backend');

/**
 * 查找 sqlite3 包的实际位置
 */
function findSqlite3Path(nodeModulesPath) {
  let sqlite3Path = path.join(nodeModulesPath, 'sqlite3');
  let sqlite3ActualPath = sqlite3Path;

  const pnpmPath = path.join(nodeModulesPath, '.pnpm');
  if (!fs.existsSync(sqlite3Path) && fs.existsSync(pnpmPath)) {
    try {
      const pnpmEntries = fs.readdirSync(pnpmPath);
      for (const entry of pnpmEntries) {
        if (entry.startsWith('sqlite3@')) {
          const sqlite3PnpmPath = path.join(pnpmPath, entry, 'node_modules', 'sqlite3');
          if (fs.existsSync(sqlite3PnpmPath)) {
            sqlite3ActualPath = sqlite3PnpmPath;
            log(logPrefix, `Found sqlite3 package at: ${sqlite3ActualPath}`);
            break;
          }
        }
      }
    } catch (err) {
      log(logPrefix, `Warning: Could not search .pnpm directory: ${err.message}`);
    }
  }

  return sqlite3ActualPath;
}

/**
 * 构建 sqlite3 原生模块
 */
function buildSqlite3NativeModule(backendTemp) {
  log(logPrefix, 'Checking sqlite3 native module...');

  const nodeModulesPath = path.join(backendTemp, 'node_modules');
  const sqlite3ActualPath = findSqlite3Path(nodeModulesPath);

  if (!fs.existsSync(sqlite3ActualPath)) {
    log(logPrefix, 'sqlite3 package not found, skipping native module build');
    return;
  }

  const sqlite3BuildPath = path.join(sqlite3ActualPath, 'build', 'Release', 'node_sqlite3.node');
  if (fs.existsSync(sqlite3BuildPath)) {
    success(logPrefix, 'sqlite3 native module already built');
    return;
  }

  log(logPrefix, 'sqlite3 native module not found, attempting to build...');
  const systemNodePath = process.execPath;
  log(logPrefix, `Using system Node.js to build sqlite3: ${systemNodePath}`);

  try {
    let nodeGypPath;
    try {
      nodeGypPath = require.resolve('node-gyp');
    } catch (err) {
      nodeGypPath = 'npx';
    }

    const buildEnv = { ...process.env };
    if (nodeGypPath !== 'npx') {
      buildEnv.npm_config_node_gyp = nodeGypPath;
    }

    const buildCommand = nodeGypPath === 'npx' ? 'npx node-gyp rebuild' : 'node-gyp rebuild';
    execSync(buildCommand, {
      cwd: sqlite3ActualPath,
      stdio: 'inherit',
      env: buildEnv,
    });

    const actualBuildPath = path.join(sqlite3ActualPath, 'build', 'Release', 'node_sqlite3.node');
    if (fs.existsSync(actualBuildPath)) {
      success(logPrefix, 'sqlite3 native module built successfully');
    } else {
      const alternativePaths = [
        path.join(sqlite3ActualPath, 'build', 'Debug', 'node_sqlite3.node'),
        path.join(sqlite3ActualPath, 'lib', 'binding', 'node-v127-darwin-arm64', 'node_sqlite3.node'),
      ];

      let found = false;
      for (const altPath of alternativePaths) {
        if (fs.existsSync(altPath)) {
          success(logPrefix, `sqlite3 native module found at: ${altPath}`);
          found = true;
          break;
        }
      }

      if (!found) {
        warn(logPrefix, 'sqlite3 native module build completed, but output file not found at expected location');
      }
    }
  } catch (err) {
    warn(logPrefix, `Failed to build sqlite3 native module: ${err.message}`);
    warn(logPrefix, 'The application may still work if sqlite3 is built elsewhere or using a different method.');
  }
}

module.exports = {
  buildSqlite3NativeModule,
};
