const fs = require('fs');
const path = require('path');
const { createLogPrefix, success, error, log } = require('../utils/logger');
const { parseCatalog, replaceCatalogRefs, processPackagesCatalog } = require('./catalog-processor');

/**
 * 获取 tego 版本
 */
function getTegoVersion(packageJson, backendTemp, logPrefix) {
  let tegoVersion = packageJson.devDependencies?.tego;

  if (!tegoVersion || tegoVersion === 'catalog:') {
    const workspaceYamlPath = path.join(backendTemp, 'pnpm-workspace.yaml');
    if (fs.existsSync(workspaceYamlPath)) {
      const yamlContent = fs.readFileSync(workspaceYamlPath, 'utf8');
      const catalogMatch = yamlContent.match(/^  tego:\s*([^\s]+)/m);
      if (catalogMatch) {
        tegoVersion = catalogMatch[1];
        log(logPrefix, `Found tego version in catalog: ${tegoVersion}`);
      }
    }

    if (!tegoVersion || tegoVersion === 'catalog:') {
      tegoVersion = '1.6.0';
      log(logPrefix, `Using default tego version: ${tegoVersion}`);
    }
  }

  return tegoVersion;
}

/**
 * 处理 package.json，添加 tego 依赖并移除开发脚本
 */
function processPackageJson(backendTemp, logPrefix) {
  const packageJsonPath = path.join(backendTemp, 'package.json');
  log(logPrefix, 'Adding tego to dependencies (required for backend server)...');

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    if (!packageJson.dependencies) {
      packageJson.dependencies = {};
    }

    const tegoVersion = getTegoVersion(packageJson, backendTemp, logPrefix);
    packageJson.dependencies.tego = tegoVersion;

    // 移除开发相关的安装脚本
    if (packageJson.scripts) {
      if (packageJson.scripts.postinstall) {
        delete packageJson.scripts.postinstall;
        log(logPrefix, 'Removed postinstall script (tachybase not available in production install)');
      }
      if (packageJson.scripts.preinstall) {
        delete packageJson.scripts.preinstall;
        log(logPrefix, 'Removed preinstall script');
      }
      if (packageJson.scripts.prepare) {
        delete packageJson.scripts.prepare;
        log(logPrefix, 'Removed prepare script (husky not needed in production)');
      }
    }

    // 处理 catalog 引用
    const workspaceYamlPath = path.join(backendTemp, 'pnpm-workspace.yaml');
    const catalogMap = parseCatalog(workspaceYamlPath);

    replaceCatalogRefs(packageJson.dependencies, catalogMap, logPrefix);
    replaceCatalogRefs(packageJson.devDependencies, catalogMap, logPrefix);
    replaceCatalogRefs(packageJson.optionalDependencies, catalogMap, logPrefix);

    // 处理 packages 目录
    processPackagesCatalog(backendTemp, catalogMap, logPrefix);

    // 写入修改后的 package.json
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    success(logPrefix, `Added tego to dependencies with version: ${tegoVersion}`);

    // 验证 postinstall 脚本是否已被删除
    const packageJsonVerify = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    if (packageJsonVerify.scripts?.postinstall) {
      error(logPrefix, 'postinstall script was not removed correctly');
      error(logPrefix, `Current scripts: ${JSON.stringify(packageJsonVerify.scripts, null, 2)}`);
      process.exit(1);
    }
    log(logPrefix, 'Verified postinstall script has been removed');

    return tegoVersion;
  } catch (err) {
    error(logPrefix, `Failed to add tego to dependencies: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  processPackageJson,
};
