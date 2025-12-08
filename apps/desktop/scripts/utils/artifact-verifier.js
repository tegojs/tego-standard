#!/usr/bin/env node

/**
 * 构建产物验证模块
 * 统一验证所有必需的构建产物
 */

const fs = require('fs');
const path = require('path');
const { getDesktopDir } = require('./paths');
const { detectAppName } = require('./app-detector');
const { createLogPrefix, success, error, warn } = require('./logger');

const logPrefix = createLogPrefix('artifact-verifier');

/**
 * 验证规则配置
 */
const VERIFICATION_RULES = {
  webDist: {
    name: 'Web Distribution',
    check: (appResourcesPath) => {
      const webDistPath = path.join(appResourcesPath, 'web-dist', 'index.html');
      return fs.existsSync(webDistPath);
    },
    path: (appResourcesPath) => path.join(appResourcesPath, 'web-dist'),
  },
  backend: {
    name: 'Backend',
    check: (appResourcesPath) => {
      const backendPath = path.join(appResourcesPath, 'backend', 'package.json');
      return fs.existsSync(backendPath);
    },
    path: (appResourcesPath) => path.join(appResourcesPath, 'backend'),
  },
  node: {
    name: 'Node Executable',
    check: (appResourcesPath) => {
      const nodePath = path.join(appResourcesPath, 'node');
      return fs.existsSync(nodePath) && fs.statSync(nodePath).isFile();
    },
    path: (appResourcesPath) => path.join(appResourcesPath, 'node'),
  },
  sqlite3: {
    name: 'SQLite3 Native Module',
    check: (appResourcesPath) => {
      const backendPath = path.join(appResourcesPath, 'backend');
      const nodeModulesPath = path.join(backendPath, 'node_modules');

      // 查找 sqlite3 包
      const sqlite3Path = path.join(nodeModulesPath, 'sqlite3');
      if (!fs.existsSync(sqlite3Path)) {
        // 尝试在 .pnpm 目录中查找
        const pnpmPath = path.join(nodeModulesPath, '.pnpm');
        if (fs.existsSync(pnpmPath)) {
          try {
            const entries = fs.readdirSync(pnpmPath);
            for (const entry of entries) {
              if (entry.startsWith('sqlite3@')) {
                const sqlite3PnpmPath = path.join(pnpmPath, entry, 'node_modules', 'sqlite3');
                if (fs.existsSync(sqlite3PnpmPath)) {
                  return verifySqlite3Module(sqlite3PnpmPath);
                }
              }
            }
          } catch (err) {
            return false;
          }
        }
        return false;
      }

      return verifySqlite3Module(sqlite3Path);
    },
    path: (appResourcesPath) => path.join(appResourcesPath, 'backend', 'node_modules', 'sqlite3'),
  },
};

/**
 * 验证 sqlite3 原生模块
 */
function verifySqlite3Module(sqlite3Path) {
  const possiblePaths = [
    path.join(sqlite3Path, 'build', 'Release', 'node_sqlite3.node'),
    path.join(sqlite3Path, 'build', 'Debug', 'node_sqlite3.node'),
    path.join(sqlite3Path, 'lib', 'binding', 'node_sqlite3.node'),
  ];

  for (const modulePath of possiblePaths) {
    if (fs.existsSync(modulePath)) {
      return true;
    }
  }

  // 尝试查找动态路径（根据 Node 版本和架构）
  try {
    const buildDir = path.join(sqlite3Path, 'build');
    if (fs.existsSync(buildDir)) {
      const buildEntries = fs.readdirSync(buildDir);
      for (const entry of buildEntries) {
        const entryPath = path.join(buildDir, entry);
        if (fs.statSync(entryPath).isDirectory()) {
          const nodeModulePath = path.join(entryPath, 'node_sqlite3.node');
          if (fs.existsSync(nodeModulePath)) {
            return true;
          }
        }
      }
    }
  } catch (err) {
    // 忽略错误
  }

  return false;
}

/**
 * 验证应用包结构
 */
function verifyAppBundleStructure(appBundlePath) {
  const requiredPaths = [
    path.join(appBundlePath, 'Contents', 'MacOS'),
    path.join(appBundlePath, 'Contents', 'Resources'),
    path.join(appBundlePath, 'Contents', 'Info.plist'),
  ];

  for (const requiredPath of requiredPaths) {
    if (!fs.existsSync(requiredPath)) {
      return { valid: false, missing: requiredPath };
    }
  }

  return { valid: true };
}

/**
 * 验证所有构建产物
 * @param {Object} options - 验证选项
 * @param {string} options.appName - 应用名称（可选，会自动检测）
 * @param {boolean} options.strict - 严格模式，任何失败都会抛出错误
 * @returns {Object} 验证结果
 */
function verifyArtifacts(options = {}) {
  const { appName: providedAppName, strict = false, arch } = options;
  const appName = providedAppName || detectAppName();
  const desktopDir = getDesktopDir();
  const { detectArchitecture } = require('./paths');
  const detectedArch = arch || detectArchitecture(desktopDir, appName);
  const appBundlePath = path.join(desktopDir, 'dist', `mac-${detectedArch}`, `${appName}.app`);
  const appResourcesPath = path.join(appBundlePath, 'Contents', 'Resources');

  const results = {
    appBundle: { valid: false, errors: [] },
    artifacts: {},
    allValid: true,
  };

  // 验证应用包结构
  const bundleCheck = verifyAppBundleStructure(appBundlePath);
  if (!bundleCheck.valid) {
    results.appBundle.valid = false;
    results.appBundle.errors.push(`Missing: ${bundleCheck.missing}`);
    results.allValid = false;
  } else {
    results.appBundle.valid = true;
  }

  // 验证各个构建产物
  for (const [key, rule] of Object.entries(VERIFICATION_RULES)) {
    const isValid = rule.check(appResourcesPath);
    const artifactPath = rule.path(appResourcesPath);

    results.artifacts[key] = {
      name: rule.name,
      valid: isValid,
      path: artifactPath,
      exists: fs.existsSync(artifactPath),
    };

    if (!isValid) {
      results.allValid = false;
      if (strict) {
        throw new Error(`${rule.name} verification failed: ${artifactPath} not found or invalid`);
      }
    }
  }

  return results;
}

/**
 * 打印验证结果
 */
function printVerificationResults(results) {
  console.log(`\n${logPrefix} Verification Results:`);
  console.log(`${logPrefix} ${'='.repeat(50)}`);

  // 应用包结构
  if (results.appBundle.valid) {
    success(logPrefix, `App Bundle Structure: Valid`);
  } else {
    error(logPrefix, `App Bundle Structure: Invalid`);
    results.appBundle.errors.forEach((err) => {
      error(logPrefix, `  - ${err}`);
    });
  }

  // 各个构建产物
  for (const [key, artifact] of Object.entries(results.artifacts)) {
    if (artifact.valid) {
      success(logPrefix, `${artifact.name}: Valid`);
    } else {
      error(logPrefix, `${artifact.name}: Invalid`);
      if (!artifact.exists) {
        error(logPrefix, `  - Path does not exist: ${artifact.path}`);
      } else {
        error(logPrefix, `  - Path exists but validation failed: ${artifact.path}`);
      }
    }
  }

  console.log(`${logPrefix} ${'='.repeat(50)}`);

  if (results.allValid) {
    success(logPrefix, 'All artifacts verified successfully');
  } else {
    warn(logPrefix, 'Some artifacts failed verification');
  }
}

module.exports = {
  verifyArtifacts,
  printVerificationResults,
  VERIFICATION_RULES,
};
