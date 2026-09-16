import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(process.cwd(), 'packages/plugin-workflow-approval');

function findRuntimeSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') {
      return [];
    }

    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return findRuntimeSources(filePath);
    }

    return /\.(ts|tsx)$/.test(entry.name) ? [filePath] : [];
  });
}

describe('workflow approval tenant module boundary', () => {
  it('does not require the optional tenant module from runtime sources', () => {
    const runtimeSources = findRuntimeSources(path.join(packageRoot, 'src/server'));

    for (const filePath of runtimeSources) {
      expect(readFileSync(filePath, 'utf8'), path.relative(packageRoot, filePath)).not.toContain(
        '@tachybase/module-tenant',
      );
    }
  });

  it('does not declare the optional tenant module as a package dependency', () => {
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

    expect(packageJson.dependencies?.['@tachybase/module-tenant']).toBeUndefined();
    expect(packageJson.devDependencies?.['@tachybase/module-tenant']).toBeUndefined();
  });
});
