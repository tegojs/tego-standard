import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getPluginDirectoryNameCandidates } from '../plugin-static-files';

describe('plugin static files', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `tego-plugin-static-files-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves package-name requests to workspace directories by package metadata', () => {
    const pluginDir = join(tempDir, 'plugin-prototype-online-user');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: '@tachybase/plugin-online-user',
      }),
    );

    expect(getPluginDirectoryNameCandidates('plugin-online-user', tempDir)).toEqual([
      'plugin-online-user',
      'plugin-prototype-online-user',
    ]);
  });
});
