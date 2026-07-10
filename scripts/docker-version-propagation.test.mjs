import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function readRepoFile(...segments) {
  return readFileSync(path.join(rootDir, ...segments), 'utf8');
}

describe('docker version propagation', () => {
  test('.dockerignore keeps .git in build context for version calculation', () => {
    const dockerignore = readRepoFile('.dockerignore');

    expect(dockerignore).not.toMatch(/^\.git$/m);
    expect(dockerignore).not.toMatch(/^\.git\/\*$/m);
  });

  test.each([
    ['docker', 'tego-nightly', 'Dockerfile'],
    ['docker', 'tego-all', 'Dockerfile'],
  ])('%s/%s/%s removes .git after build metadata is computed', (...segments) => {
    const dockerfile = readRepoFile(...segments);

    expect(dockerfile).toContain('RUN pnpm build:p');
    expect(dockerfile).toContain('RUN rm -rf /app/.git');
  });

  test.each([
    ['docker', 'tego-nightly', 'Dockerfile'],
    ['docker', 'tego-all', 'Dockerfile'],
  ])('%s/%s/%s copies pnpm patches before dependency install', (...segments) => {
    const dockerfile = readRepoFile(...segments);
    const copyPatchesIndex = dockerfile.indexOf('cp -R /context/patches /app/patches');
    const installIndex = dockerfile.indexOf('pnpm install --shamefully-hoist');

    expect(copyPatchesIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(copyPatchesIndex).toBeLessThan(installIndex);
  });
});
