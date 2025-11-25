#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getProjectRoot } = require('./utils/paths');
const { removeDirectory, ensureDirectory } = require('./utils/file-operations');
const { createLogPrefix, success, error, log } = require('./utils/logger');

const logPrefix = createLogPrefix('prepare-backend');

const projectRoot = getProjectRoot();
const backendTemp = path.resolve(__dirname, '..', 'backend-temp');

console.log(`${logPrefix} Preparing backend for packaging...`);
console.log(`${logPrefix} Project root: ${projectRoot}`);
console.log(`${logPrefix} Backend temp: ${backendTemp}`);

// 检查项目根目录
if (!fs.existsSync(projectRoot)) {
  error(logPrefix, `Project root not found at ${projectRoot}`);
  process.exit(1);
}

// 清理临时目录
removeDirectory(backendTemp, logPrefix);

// 创建临时目录
ensureDirectory(backendTemp);

// 需要复制的文件和目录
const BACKEND_ITEMS_TO_COPY = [
  { src: 'packages', dest: 'packages' },
  { src: 'package.json', dest: 'package.json' },
  { src: 'pnpm-workspace.yaml', dest: 'pnpm-workspace.yaml' },
  { src: '.env.example', dest: '.env.example' },
];

// 复制后端文件
log(logPrefix, 'Copying backend files...');
for (const item of BACKEND_ITEMS_TO_COPY) {
  const srcPath = path.join(projectRoot, item.src);
  const destPath = path.join(backendTemp, item.dest);

  if (fs.existsSync(srcPath)) {
    try {
      const stats = fs.lstatSync(srcPath);
      if (stats.isDirectory()) {
        execSync(`cp -R "${srcPath}" "${destPath}"`, { stdio: 'inherit' });
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
      success(logPrefix, `Copied ${item.src}`);
    } catch (err) {
      error(logPrefix, `Failed to copy ${item.src}: ${err.message}`);
      process.exit(1);
    }
  } else {
    error(logPrefix, `Source not found: ${srcPath}`);
    process.exit(1);
  }
}

// tego 在根 package.json 中是 devDependency，但后端需要它
// 修改 backend-temp/package.json 来添加 tego 作为生产依赖
const packageJsonPath = path.join(backendTemp, 'package.json');
log(logPrefix, 'Adding tego to dependencies (required for backend server)...');
try {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // 确保 dependencies 对象存在
  if (!packageJson.dependencies) {
    packageJson.dependencies = {};
  }

  // 从 devDependencies 中获取 tego 的版本
  // 如果版本是 'catalog:'，从 pnpm-workspace.yaml 中读取实际版本
  let tegoVersion = packageJson.devDependencies?.tego;

  if (!tegoVersion || tegoVersion === 'catalog:') {
    // 读取 pnpm-workspace.yaml 获取 catalog 中的版本
    const workspaceYamlPath = path.join(backendTemp, 'pnpm-workspace.yaml');
    if (fs.existsSync(workspaceYamlPath)) {
      const yamlContent = fs.readFileSync(workspaceYamlPath, 'utf8');
      const catalogMatch = yamlContent.match(/^  tego:\s*([^\s]+)/m);
      if (catalogMatch) {
        tegoVersion = catalogMatch[1];
        log(logPrefix, `Found tego version in catalog: ${tegoVersion}`);
      }
    }

    // 如果还是找不到，使用默认版本
    if (!tegoVersion || tegoVersion === 'catalog:') {
      tegoVersion = '1.3.52'; // 从 pnpm-workspace.yaml 中看到的版本
      log(logPrefix, `Using default tego version: ${tegoVersion}`);
    }
  }

  packageJson.dependencies.tego = tegoVersion;

  // 写入修改后的 package.json
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  success(logPrefix, `Added tego to dependencies with version: ${tegoVersion}`);
} catch (err) {
  error(logPrefix, `Failed to add tego to dependencies: ${err.message}`);
  process.exit(1);
}

// 在临时目录中安装生产依赖
// 使用 pnpm install --prod 安装生产依赖，pnpm 会自动处理 workspace 和依赖关系
log(logPrefix, 'Installing production dependencies with pnpm...');
try {
  // 复制 pnpm-lock.yaml 以确保版本一致性
  const lockFileSrc = path.join(projectRoot, 'pnpm-lock.yaml');
  if (fs.existsSync(lockFileSrc)) {
    fs.copyFileSync(lockFileSrc, path.join(backendTemp, 'pnpm-lock.yaml'));
    log(logPrefix, 'Copied pnpm-lock.yaml for consistent dependency resolution');
  }

  // 验证 package.json 中是否包含 tego
  const packageJsonAfter = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (!packageJsonAfter.dependencies?.tego) {
    error(logPrefix, 'tego was not added to dependencies correctly');
    error(logPrefix, `Current dependencies: ${JSON.stringify(packageJsonAfter.dependencies || {}, null, 2)}`);
    process.exit(1);
  }
  log(logPrefix, `Verified tego in dependencies: ${packageJsonAfter.dependencies.tego}`);

  // 安装生产依赖
  // --prod: 只安装生产依赖
  // 注意：不使用 --frozen-lockfile，因为我们已经修改了 package.json（添加了 tego）
  // --no-optional: 不安装可选依赖（可选，减少体积）
  execSync('pnpm install --prod', {
    cwd: backendTemp,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  success(logPrefix, 'Dependencies installed successfully');
} catch (err) {
  error(logPrefix, `Failed to install dependencies: ${err.message}`);
  process.exit(1);
}

// 验证安装结果
const nodeModulesPath = path.join(backendTemp, 'node_modules');
// 在 pnpm isolated 模式下，包可能在 .pnpm 中，但 node_modules 中应该有符号链接
// 检查 tego.js 文件是否存在（这是实际需要的文件）
const tegoJsPath = path.join(nodeModulesPath, 'tego', 'bin', 'tego.js');
const tegoBinPath = path.join(nodeModulesPath, '.bin', 'tego');
const tegoPath = path.join(nodeModulesPath, 'tego');

// 检查 tego.js 或 .bin/tego 是否存在
if (!fs.existsSync(tegoJsPath) && !fs.existsSync(tegoBinPath)) {
  // 如果都不存在，检查 tego 目录是否存在（可能是符号链接）
  if (!fs.existsSync(tegoPath)) {
    // 尝试显式安装 tego
    log(logPrefix, 'tego not found after install, attempting explicit installation...');
    try {
      const packageJsonAfter = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const tegoVersion = packageJsonAfter.dependencies?.tego || '1.3.52';
      log(logPrefix, `Installing tego@${tegoVersion} explicitly...`);
      execSync(`pnpm add tego@${tegoVersion} --save-prod`, {
        cwd: backendTemp,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'production' },
      });
      success(logPrefix, 'tego installed explicitly');

      // 再次检查
      if (!fs.existsSync(tegoJsPath) && !fs.existsSync(tegoBinPath) && !fs.existsSync(tegoPath)) {
        error(logPrefix, 'tego package still not found after explicit installation');
        error(logPrefix, `Expected tego.js at: ${tegoJsPath}`);
        error(logPrefix, `Expected tego bin at: ${tegoBinPath}`);
        error(logPrefix, `Expected tego directory at: ${tegoPath}`);
        process.exit(1);
      }
    } catch (err) {
      error(logPrefix, `Failed to install tego explicitly: ${err.message}`);
      error(logPrefix, `Expected tego.js at: ${tegoJsPath}`);
      error(logPrefix, `Expected tego bin at: ${tegoBinPath}`);
      error(logPrefix, `Expected tego directory at: ${tegoPath}`);
      process.exit(1);
    }
  }
}

// chalk 是 tego 的依赖，应该会自动安装
// 但为了确保，我们也检查一下
const chalkPath = path.join(nodeModulesPath, 'chalk');
if (!fs.existsSync(chalkPath)) {
  log(logPrefix, 'chalk not found, installing...');
  try {
    execSync('pnpm add chalk --save-prod', {
      cwd: backendTemp,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    });
  } catch (err) {
    // chalk 可能不是必需的，只记录警告
    log(logPrefix, `Warning: Could not install chalk: ${err.message}`);
  }
}

success(logPrefix, 'Backend prepared successfully');
console.log(`${logPrefix} Backend directory: ${backendTemp}`);
