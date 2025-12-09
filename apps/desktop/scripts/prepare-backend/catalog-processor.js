const fs = require('fs');
const path = require('path');
const { createLogPrefix, log } = require('../utils/logger');

/**
 * 解析 pnpm-workspace.yaml 中的 catalog
 */
function parseCatalog(workspaceYamlPath) {
  const catalogMap = {};

  if (!fs.existsSync(workspaceYamlPath)) {
    return catalogMap;
  }

  const yamlContent = fs.readFileSync(workspaceYamlPath, 'utf8');
  const catalogLines = yamlContent.split('\n');
  let inCatalog = false;

  for (const line of catalogLines) {
    if (line.trim() === 'catalog:') {
      inCatalog = true;
      continue;
    }
    if (inCatalog) {
      if (line.match(/^\w/)) {
        break;
      }
      let match = line.match(/^\s+['"]([^'"]+)['"]:\s*(.+)$/);
      if (!match) {
        match = line.match(/^\s+([^:]+):\s*(.+)$/);
      }
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        catalogMap[key] = value;
      }
    }
  }

  return catalogMap;
}

/**
 * 替换依赖中的 catalog: 引用
 */
function replaceCatalogRefs(deps, catalogMap, logPrefix) {
  if (!deps) return;
  for (const [key, value] of Object.entries(deps)) {
    if (value === 'catalog:' && catalogMap[key]) {
      deps[key] = catalogMap[key];
      log(logPrefix, `Replaced catalog: reference for ${key} with version ${catalogMap[key]}`);
    }
  }
}

/**
 * 递归处理 packages 目录中的所有 package.json
 */
function processPackagesCatalog(backendTemp, catalogMap, logPrefix) {
  const packagesDir = path.join(backendTemp, 'packages');
  if (!fs.existsSync(packagesDir)) {
    return;
  }

  const processPackageJson = (dir) => {
    const packageJsonFile = path.join(dir, 'package.json');
    if (fs.existsSync(packageJsonFile)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(packageJsonFile, 'utf8'));
        let modified = false;

        const replaceInPkg = (deps) => {
          if (!deps) return;
          for (const [key, value] of Object.entries(deps)) {
            if (value === 'catalog:' && catalogMap[key]) {
              deps[key] = catalogMap[key];
              modified = true;
            }
          }
        };

        replaceInPkg(pkgJson.dependencies);
        replaceInPkg(pkgJson.devDependencies);
        replaceInPkg(pkgJson.optionalDependencies);
        replaceInPkg(pkgJson.peerDependencies);

        if (modified) {
          fs.writeFileSync(packageJsonFile, JSON.stringify(pkgJson, null, 2) + '\n');
          log(logPrefix, `Updated catalog references in ${path.relative(backendTemp, packageJsonFile)}`);
        }
      } catch (err) {
        log(logPrefix, `Warning: Could not process ${packageJsonFile}: ${err.message}`);
      }
    }

    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const entryPath = path.join(dir, entry);
        const stat = fs.lstatSync(entryPath);
        if (stat.isDirectory()) {
          processPackageJson(entryPath);
        }
      }
    } catch (err) {
      // 忽略读取错误
    }
  };

  processPackageJson(packagesDir);
}

module.exports = {
  parseCatalog,
  replaceCatalogRefs,
  processPackagesCatalog,
};
