import { createRequire } from 'node:module';
import { createMockServer } from '@tachybase/test';
import { Application, AppSupervisor, Plugin, uid } from '@tego/server';

import { vi } from 'vitest';

const serverRequire = createRequire(require.resolve('@tego/server/package.json'));
const coreRequire = createRequire(serverRequire.resolve('@tego/core/package.json'));
const TachybaseGlobal = coreRequire('@tachybase/globals').default || coreRequire('@tachybase/globals');

describe('test with start', () => {
  it('should load subApp on create', async () => {
    const loadFn = vi.fn();
    const installFn = vi.fn();

    class TestPlugin extends Plugin {
      getName(): string {
        return 'test-package';
      }

      get name() {
        return 'test-package';
      }

      async load(): Promise<void> {
        loadFn();
      }

      async install() {
        installFn();
      }
    }

    const presets = TachybaseGlobal.getInstance().get<Record<string, any>>('PRESETS') || {};
    TachybaseGlobal.getInstance().set('PRESETS', {
      ...presets,
      'test-package': TestPlugin,
    });

    let app: Application | undefined;
    let subApp: Application | undefined;

    try {
      app = await createMockServer({
        plugins: ['multi-app-manager'],
      });

      const db = app.db;

      const name = `d_${uid()}`;

      await db.getRepository('applications').create({
        values: {
          name,
          options: {
            autoStart: true,
            plugins: ['test-package'],
          },
        },
        context: {
          waitSubAppInstall: true,
        },
      });

      expect(loadFn).toHaveBeenCalled();
      expect(installFn).toHaveBeenCalledTimes(1);

      subApp = await AppSupervisor.getInstance().getApp(name);
    } finally {
      await subApp?.destroy();
      await app?.destroy();
      TachybaseGlobal.getInstance().set('PRESETS', presets);
    }
  });

  it('should install into difference database', async () => {
    let app: Application | undefined;
    let subApp: Application | undefined;

    try {
      app = await createMockServer({
        plugins: ['multi-app-manager'],
      });

      const db = app.db;

      const name = `d_${uid()}`;

      await db.getRepository('applications').create({
        values: {
          name,
          options: {
            autoStart: true,
            plugins: ['ui-schema-storage'],
          },
        },
        context: {
          waitSubAppInstall: true,
        },
      });
      subApp = await AppSupervisor.getInstance().getApp(name);
    } finally {
      await subApp?.destroy();
      await app?.destroy();
    }
  });
});
