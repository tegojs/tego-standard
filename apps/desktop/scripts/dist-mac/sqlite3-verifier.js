const fs = require('fs');
const path = require('path');
const { getAppResourcesPath } = require('../utils/paths');
const { createLogPrefix, step, success, error } = require('../utils/logger');

const logPrefix = createLogPrefix('dist-mac');

/**
 * 验证打包后的应用中是否包含 sqlite3 原生模块
 */
function verifySqlite3NativeModule(appName) {
  step(logPrefix, 'verify-sqlite3');
  const resourcesPath = getAppResourcesPath(appName);
  const backendPath = path.join(resourcesPath, 'backend');
  const nodeModulesPath = path.join(backendPath, 'node_modules');

  if (!fs.existsSync(backendPath)) {
    error(logPrefix, `Backend directory not found at: ${backendPath}`);
    return false;
  }

  const checkPaths = [
    path.join(nodeModulesPath, 'sqlite3', 'build', 'Release', 'node_sqlite3.node'),
    path.join(nodeModulesPath, 'sqlite3', 'build', 'Debug', 'node_sqlite3.node'),
  ];

  for (const checkPath of checkPaths) {
    if (fs.existsSync(checkPath)) {
      success(logPrefix, `sqlite3 native module verified at: ${path.relative(resourcesPath, checkPath)}`);
      return true;
    }
  }

  const pnpmPath = path.join(nodeModulesPath, '.pnpm');
  if (fs.existsSync(pnpmPath)) {
    try {
      const pnpmEntries = fs.readdirSync(pnpmPath);
      for (const entry of pnpmEntries) {
        if (entry.startsWith('sqlite3@')) {
          const sqlite3PnpmPath = path.join(pnpmPath, entry, 'node_modules', 'sqlite3');
          const pnpmCheckPaths = [
            path.join(sqlite3PnpmPath, 'build', 'Release', 'node_sqlite3.node'),
            path.join(sqlite3PnpmPath, 'build', 'Debug', 'node_sqlite3.node'),
            path.join(sqlite3PnpmPath, 'lib', 'binding', 'node-v127-darwin-arm64', 'node_sqlite3.node'),
            path.join(sqlite3PnpmPath, 'compiled', '22.16.0', 'darwin', 'arm64', 'node_sqlite3.node'),
          ];
          for (const pnpmCheckPath of pnpmCheckPaths) {
            if (fs.existsSync(pnpmCheckPath)) {
              success(logPrefix, `sqlite3 native module verified at: ${path.relative(resourcesPath, pnpmCheckPath)}`);
              return true;
            }
          }
        }
      }
    } catch (e) {
      log(logPrefix, `Warning: Could not check .pnpm directory: ${e.message}`, 'warn');
    }
  }

  error(logPrefix, 'sqlite3 native module not found in packaged app');
  error(logPrefix, 'This will cause runtime errors when starting the backend server.');
  error(logPrefix, 'Please ensure sqlite3 is built during prepare-backend step.');
  return false;
}

module.exports = {
  verifySqlite3NativeModule,
};
