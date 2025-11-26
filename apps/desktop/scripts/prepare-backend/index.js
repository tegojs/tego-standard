#!/usr/bin/env node

/**
 * 准备后端环境
 * 复制文件、处理依赖、构建原生模块
 */

const path = require('path');
const { getProjectRoot, getDesktopDir } = require('../utils/paths');
const { createLogPrefix, title, success, error } = require('../utils/logger');
const { createTaskList, runTasks } = require('../utils/task-runner');
const { copyBackendFiles, prepareTempDirectory } = require('./file-copier');
const { processPackageJson } = require('./package-processor');
const { installProductionDependencies } = require('./dependency-installer');
const { verifyTegoInstallation } = require('./tego-verifier');
const { checkAndInstallChalk } = require('./chalk-installer');
const { buildSqlite3NativeModule } = require('./sqlite3-builder');

const logPrefix = createLogPrefix('prepare-backend');
const projectRoot = getProjectRoot();
const desktopDir = getDesktopDir();
const backendTemp = path.resolve(desktopDir, 'backend-temp');

/**
 * 创建准备后端的任务列表
 */
function createPrepareBackendTasks() {
  return createTaskList([
    {
      title: 'Preparing temporary directory',
      task: async () => {
        prepareTempDirectory(backendTemp, logPrefix);
      },
    },
    {
      title: 'Copying backend files',
      task: async () => {
        copyBackendFiles(projectRoot, backendTemp, logPrefix);
      },
    },
    {
      title: 'Processing package.json',
      task: async () => {
        processPackageJson(backendTemp, logPrefix);
      },
    },
    {
      title: 'Installing production dependencies',
      task: async () => {
        const packageJsonPath = path.join(backendTemp, 'package.json');
        installProductionDependencies(backendTemp, packageJsonPath, logPrefix);
      },
    },
    {
      title: 'Verifying tego installation',
      task: async () => {
        const packageJsonPath = path.join(backendTemp, 'package.json');
        verifyTegoInstallation(backendTemp, packageJsonPath, logPrefix);
      },
    },
    {
      title: 'Checking and installing chalk',
      task: async () => {
        checkAndInstallChalk(backendTemp, logPrefix);
      },
    },
    {
      title: 'Building sqlite3 native module',
      task: async () => {
        buildSqlite3NativeModule(backendTemp);
      },
    },
  ]);
}

async function main() {
  title('Preparing Backend for Packaging');

  const tasks = createPrepareBackendTasks();
  const result = await runTasks(tasks);

  if (result) {
    success(logPrefix, 'Backend prepared successfully');
    console.log(`${logPrefix} Backend directory: ${backendTemp}`);
    process.exit(0);
  } else {
    error(logPrefix, 'Backend preparation failed');
    process.exit(1);
  }
}

main().catch((err) => {
  error(logPrefix, `Unexpected error: ${err.message || err}`);
  process.exit(1);
});
