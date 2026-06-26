import { createMockServer, MockServer } from '@tachybase/test';
import { AppSupervisor, Plugin } from '@tego/server';

import PluginTenantServer from '..';

async function cleanupPreviousApp(): Promise<void> {
  try {
    const supervisor = AppSupervisor.getInstance();
    const existing = await supervisor.getApp('main', { withOutBootStrap: true } as any);
    if (existing) {
      await existing.destroy({ logging: false }).catch(() => {});
    }
  } catch {
    /* no previous app — that's fine */
  }
}

/**
 * Replace db.sync with queryInterface.createTable to bypass:
 *   1. FK topo-sort abort in sequelize.sync()
 *   2. afterSync hooks (sort-field queries non-existent tables)
 *
 * Also monkey-patches pm.install to capture whether it runs.
 */
function patchForCI(app: MockServer): void {
  const db = app.db as any;

  // Replace db.sync
  const origSync = db.sync;
  db.sync = async function safeSync() {
    const qi = db.sequelize.getQueryInterface();
    for (const model of Object.values(db.sequelize.models) as any[]) {
      try {
        await qi.createTable(model.tableName, model.rawAttributes, {});
      } catch {
        /* already exists */
      }
    }
  };

  // Monkey-patch Application.install to add diagnostics around pm.install
  const appAny = app as any;
  const origAppInstall = appAny.install.bind(appAny);
  appAny.install = async function patchedInstall(options: any) {
    // Run clean + reInit + first db.sync + load manually
    const reinstall = options?.clean || options?.force;
    if (reinstall) {
      await db.clean({ drop: true });
    }
    if (await appAny.isInstalled()) {
      return; // already installed
    }
    // reInit is no-op for fresh app
    await db.sync(); // first sync — only framework models
    await appAny.load({ hooks: false }); // registers all collections/models

    // NOW the real test: call pm.install
    try {
      await appAny.pm.install();
    } catch (e: any) {
      throw new Error(`pm.install FAILED: ${e.message?.slice(0, 200)}`);
    }
    await appAny.version.update();
    if (appAny._started) {
      await appAny.restart();
    }
  };
}

export async function createTenantApp(options: { extraPlugins?: any[] } = {}): Promise<MockServer> {
  const { extraPlugins = [] } = options;

  await cleanupPreviousApp();

  class TestAuthStatusPlugin extends Plugin {
    async load() {
      if (!this.app.authManager.userStatusService) {
        this.app.authManager.setUserStatusService({
          async checkUserStatus() {
            return { allowed: true, status: 'active', isExpired: false };
          },
        });
      }
    }

    async install() {
      const rolesRepository = this.app.db.getRepository('roles');
      for (const role of [
        { name: 'admin', title: 'Admin' },
        { name: 'root', title: 'Root' },
      ]) {
        const values = {
          ...role,
          strategy: {
            actions: ['create', 'view', 'update', 'destroy', 'list', 'get', 'count', 'importXlsx'],
          },
        };
        const existing = await rolesRepository.findOne({ filterByTk: role.name });
        if (existing) {
          await rolesRepository.update({ filterByTk: role.name, values });
        } else {
          await rolesRepository.create({ values });
        }
      }
    }
  }

  let app: MockServer;
  try {
    app = await createMockServer({
      registerActions: true,
      acl: true,
      database: { dialect: 'sqlite' },
      beforeInstall: (a: MockServer) => {
        patchForCI(a);
      },
      plugins: [
        'acl',
        'error-handler',
        'users',
        'ui-schema-storage',
        'collection-manager',
        'auth',
        'data-source-manager',
        [PluginTenantServer, { name: 'tenant', packageName: '@tachybase/module-tenant', workspaceSource: true }],
        ...extraPlugins,
        TestAuthStatusPlugin,
      ],
    });
  } catch (err: any) {
    await cleanupPreviousApp();
    throw err;
  }

  const check = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  const tableNames = (check[0] as any[]).map((r: any) => r.name);
  if (!tableNames.includes('tenants')) {
    throw new Error(
      `[createTenantApp] tenants missing. ` +
        `Tables(${tableNames.length}): ${tableNames.slice(0, 8).join(',')}. ` +
        `Models(${Object.keys((app.db.sequelize as any).models || {}).length}). ` +
        `Collections(${app.db.collections.size}). ` +
        `syncName: ${app.db.sync?.name}. ` +
        `Storage: ${(app.db as any).options?.storage}`,
    );
  }
  return app;
}
