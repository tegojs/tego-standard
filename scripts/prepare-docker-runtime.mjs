import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_RUNTIME_FILES = ['package.json', 'pnpm-workspace.yaml', '.version.json'];
const PACKAGE_RUNTIME_DIRS = new Set(['dist', 'lib', 'es']);
const PACKAGE_REQUIRED_FILES = new Set(['package.json', 'client.js', 'client.d.ts', 'server.js', 'server.d.ts', '.npmignore']);
const PACKAGE_EXCLUDED_FILES = new Set(['.gitignore', 'build.config.ts']);
const PACKAGE_EXCLUDED_PATTERNS = [
  /^README(?:\.[^.]+)?\.md$/i,
  /^CHANGELOG(?:\.[^.]+)?\.md$/i,
  /^tsconfig(?:\..+)?\.json$/i,
  /^e2e(?:\.d\.ts|\.js)$/i,
];
const NORMALIZED_TIME = new Date('2000-01-01T00:00:00.000Z');

function shouldCopyPackageFile(name) {
  if (PACKAGE_REQUIRED_FILES.has(name)) {
    return true;
  }

  if (PACKAGE_EXCLUDED_FILES.has(name)) {
    return false;
  }

  return !PACKAGE_EXCLUDED_PATTERNS.some((pattern) => pattern.test(name));
}

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function bestEffortRemove(targetPath) {
  try {
    await fs.rm(targetPath, { force: true, recursive: true });
  } catch {
    // Local Windows workspaces can contain junction-heavy historical output.
    // Keep the current run unblocked and let stale temp dirs be cleaned manually if needed.
  }
}

async function resetRuntimeDir(runtimeDir) {
  if (!(await pathExists(runtimeDir))) {
    return;
  }

  const staleRuntimeDir = `${runtimeDir}.stale-${Date.now()}`;
  await fs.rename(runtimeDir, staleRuntimeDir);
  void bestEffortRemove(staleRuntimeDir);
}

async function ensureParentDir(targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

async function copySymlink(sourcePath, targetPath) {
  const linkTarget = await fs.readlink(sourcePath);
  let linkType = 'file';

  try {
    const resolvedTarget = path.resolve(path.dirname(sourcePath), linkTarget);
    const targetStats = await fs.stat(resolvedTarget);
    if (targetStats.isDirectory()) {
      linkType = process.platform === 'win32' ? 'junction' : 'dir';
    }
  } catch {
    // Preserve unresolved links as file symlinks when the target cannot be inspected.
  }

  await ensureParentDir(targetPath);
  await fs.symlink(linkTarget, targetPath, linkType);
}

async function copyDirectory(sourcePath, targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    await copyEntry(path.join(sourcePath, entry.name), path.join(targetPath, entry.name));
  }
}

async function copyEntry(sourcePath, targetPath) {
  const stats = await fs.lstat(sourcePath);

  if (stats.isSymbolicLink()) {
    await copySymlink(sourcePath, targetPath);
    return;
  }

  if (stats.isDirectory()) {
    await copyDirectory(sourcePath, targetPath);
    return;
  }

  await ensureParentDir(targetPath);
  await fs.copyFile(sourcePath, targetPath);
}

async function normalizeTree(targetPath) {
  const stats = await fs.lstat(targetPath);

  if (stats.isDirectory()) {
    const entries = await fs.readdir(targetPath);
    for (const entry of entries) {
      await normalizeTree(path.join(targetPath, entry));
    }
    await fs.utimes(targetPath, NORMALIZED_TIME, NORMALIZED_TIME);
    return;
  }

  if (stats.isSymbolicLink()) {
    if (typeof fs.lutimes === 'function') {
      try {
        await fs.lutimes(targetPath, NORMALIZED_TIME, NORMALIZED_TIME);
      } catch {
        // Some filesystems do not support updating symlink timestamps.
      }
    }
    return;
  }

  await fs.utimes(targetPath, NORMALIZED_TIME, NORMALIZED_TIME);
}

async function copyRootRuntimeFiles(rootDir, runtimeDir) {
  for (const fileName of ROOT_RUNTIME_FILES) {
    const sourcePath = path.join(rootDir, fileName);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    await copyEntry(sourcePath, path.join(runtimeDir, fileName));
  }
}

async function copyPackageRuntime(rootDir, runtimeDir) {
  const packagesDir = path.join(rootDir, 'packages');
  if (!(await pathExists(packagesDir))) {
    return;
  }

  const packageEntries = await fs.readdir(packagesDir, { withFileTypes: true });
  for (const packageEntry of packageEntries) {
    if (!packageEntry.isDirectory()) {
      continue;
    }

    const sourcePackageDir = path.join(packagesDir, packageEntry.name);
    const targetPackageDir = path.join(runtimeDir, 'packages', packageEntry.name);
    await fs.mkdir(targetPackageDir, { recursive: true });

    const entries = await fs.readdir(sourcePackageDir, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourcePackageDir, entry.name);
      const targetPath = path.join(targetPackageDir, entry.name);

      if (entry.isDirectory()) {
        if (!PACKAGE_RUNTIME_DIRS.has(entry.name)) {
          continue;
        }

        await copyEntry(sourcePath, targetPath);
        continue;
      }

      if ((entry.isFile() || entry.isSymbolicLink()) && shouldCopyPackageFile(entry.name)) {
        await copyEntry(sourcePath, targetPath);
      }
    }
  }
}

export async function prepareDockerRuntime(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : process.cwd();
  const runtimeDir = options.runtimeDir ? path.resolve(options.runtimeDir) : path.join(rootDir, '.docker-runtime');

  await resetRuntimeDir(runtimeDir);
  await fs.mkdir(path.join(runtimeDir, 'packages'), { recursive: true });

  await copyRootRuntimeFiles(rootDir, runtimeDir);
  await copyPackageRuntime(rootDir, runtimeDir);
  await normalizeTree(runtimeDir);

  return runtimeDir;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await prepareDockerRuntime();
}
