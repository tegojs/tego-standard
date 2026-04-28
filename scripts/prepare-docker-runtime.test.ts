import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { prepareDockerRuntime } from './prepare-docker-runtime.mjs';

const workdirs: string[] = [];

async function createWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'prepare-docker-runtime-'));
  workdirs.push(root);
  return root;
}

afterEach(async () => {
  for (const dir of workdirs.splice(0)) {
    await import('node:fs/promises').then((fs) => fs.rm(dir, { force: true, recursive: true }));
  }
});

describe('prepareDockerRuntime', () => {
  test('copies runtime package files, removes dev-only files, and normalizes mtimes', async () => {
    const rootDir = await createWorkspace();
    const packagesDir = path.join(rootDir, 'packages');
    const runtimeDir = path.join(rootDir, '.docker-runtime');
    const packageDir = path.join(packagesDir, 'module-worker-thread');

    await mkdir(path.join(packageDir, 'dist', 'server'), { recursive: true });
    await mkdir(path.join(packageDir, 'lib'), { recursive: true });
    await mkdir(path.join(packageDir, 'es'), { recursive: true });
    await mkdir(path.join(packageDir, 'node_modules', 'dep'), { recursive: true });
    await mkdir(path.join(packageDir, 'src'), { recursive: true });
    await mkdir(path.join(packageDir, 'docs'), { recursive: true });

    await writeFile(path.join(rootDir, 'package.json'), '{"name":"app"}');
    await writeFile(path.join(rootDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(path.join(rootDir, '.version.json'), '{"version":"1.0.0"}');

    await writeFile(path.join(packageDir, 'package.json'), '{"name":"@tachybase/module-worker-thread"}');
    await writeFile(path.join(packageDir, 'worker-starter.js'), 'console.log("worker");\n');
    await writeFile(path.join(packageDir, 'server.d.ts'), 'export {};\n');
    await writeFile(path.join(packageDir, '.npmignore'), 'src\n');
    await writeFile(path.join(packageDir, 'LICENSE'), 'license\n');
    await writeFile(path.join(packageDir, 'build.config.ts'), 'export default {};\n');
    await writeFile(path.join(packageDir, 'README.md'), '# docs\n');
    await writeFile(path.join(packageDir, 'tsconfig.paths.json'), '{}\n');
    await writeFile(path.join(packageDir, 'src', 'server.ts'), 'export const nope = true;\n');
    await writeFile(path.join(packageDir, 'docs', 'guide.md'), '# guide\n');
    await writeFile(path.join(packageDir, 'dist', 'server', 'index.js'), 'exports.ok = true;\n');
    await writeFile(path.join(packageDir, 'lib', 'index.js'), 'exports.lib = true;\n');
    await writeFile(path.join(packageDir, 'es', 'index.js'), 'export const es = true;\n');
    await writeFile(path.join(packageDir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');

    await prepareDockerRuntime({ rootDir, runtimeDir });

    await expect(readFile(path.join(runtimeDir, 'package.json'), 'utf8')).resolves.toContain('"name":"app"');
    await expect(
      readFile(path.join(runtimeDir, 'packages', 'module-worker-thread', 'worker-starter.js'), 'utf8'),
    ).resolves.toContain('worker');
    await expect(
      readFile(path.join(runtimeDir, 'packages', 'module-worker-thread', 'LICENSE'), 'utf8'),
    ).resolves.toContain('license');
    await expect(
      readFile(path.join(runtimeDir, 'packages', 'module-worker-thread', 'dist', 'server', 'index.js'), 'utf8'),
    ).resolves.toContain('ok');
    await expect(stat(path.join(runtimeDir, 'packages', 'module-worker-thread', 'src', 'server.ts'))).rejects.toThrow();
    await expect(stat(path.join(runtimeDir, 'packages', 'module-worker-thread', 'docs', 'guide.md'))).rejects.toThrow();
    await expect(stat(path.join(runtimeDir, 'packages', 'module-worker-thread', 'build.config.ts'))).rejects.toThrow();
    await expect(stat(path.join(runtimeDir, 'packages', 'module-worker-thread', 'README.md'))).rejects.toThrow();
    await expect(
      stat(path.join(runtimeDir, 'packages', 'module-worker-thread', 'tsconfig.paths.json')),
    ).rejects.toThrow();
    await expect(stat(path.join(runtimeDir, 'packages', 'module-worker-thread', 'node_modules'))).rejects.toThrow();

    const copiedFileStat = await stat(path.join(runtimeDir, 'packages', 'module-worker-thread', 'worker-starter.js'));
    expect(copiedFileStat.mtimeMs).toBe(946684800000);
  });

  test('keeps package-specific runtime files outside dist/lib/es when needed', async () => {
    const rootDir = await createWorkspace();
    const runtimeDir = path.join(rootDir, '.docker-runtime');
    const packageDir = path.join(rootDir, 'packages', 'plugin-workflow-test');

    await writeFile(path.join(rootDir, 'package.json'), '{"name":"app"}');
    await writeFile(path.join(rootDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await mkdir(path.join(packageDir, 'dist', 'server'), { recursive: true });
    await writeFile(path.join(packageDir, 'package.json'), '{"name":"@tachybase/plugin-workflow-test"}');
    await writeFile(path.join(packageDir, 'dist', 'server', 'index.js'), 'exports.test = true;\n');
    await writeFile(path.join(packageDir, 'e2e.js'), 'module.exports = {};\n');
    await writeFile(path.join(packageDir, 'e2e.d.ts'), 'export {};\n');

    await prepareDockerRuntime({ rootDir, runtimeDir });

    await expect(
      readFile(path.join(runtimeDir, 'packages', 'plugin-workflow-test', 'dist', 'server', 'index.js'), 'utf8'),
    ).resolves.toContain('exports.test');
    await expect(stat(path.join(runtimeDir, 'packages', 'plugin-workflow-test', 'e2e.js'))).rejects.toThrow();
    await expect(stat(path.join(runtimeDir, 'packages', 'plugin-workflow-test', 'e2e.d.ts'))).rejects.toThrow();
  });
});
