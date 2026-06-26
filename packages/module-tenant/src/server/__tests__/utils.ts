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

let installError = '';

function patchInstall(app: MockServer): void {
  const db = app.db as any;
  const origSync = db.sync;
  installError = '';

  // Replace db.sync with createTable-based version
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

  // Wrap pm.install to capture errors
  const pm = (app as any).pm;
  const origPmInstall = pm.install.bind(pm);
  pm.install = async function (...args: any[]) {
    try {
      return await origPmInstall(...args);
    } catch (e: any) {
      installError = `pm.install FAILED: ${e.message?.slice(0, 200)}`;
      throw e;
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
      skipInstall: true,
      skipStart: true,
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

    // Replace db.sync with safe createTable version BEFORE install
    patchInstall(app);

    // Run install directly — bypass CLI's runCommandThrowError which
    // silently swallows errors in CI.
    await (app as any).install({ force: true });
    await (app as any).start();
  } catch (err: any) {
    await cleanupPreviousApp();
    throw new Error(
      `[createTenantApp] FAILED: ${err.message?.slice(0, 300)}. ` +
        `installError: [${installError}]`,
    );
  }

  const check = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  const tableNames = (check[0] as any[]).map((r: any) => r.name);
  if (!tableNames.includes('tenants')) {
    throw new Error(
      `[createTenantApp] tenants missing. installError: [${installError}]. ` +
        `Tables(${tableNames.length}): ${tableNames.slice(0, 10).join(',')}. ` +
        `Models(${Object.keys((app.db.sequelize as any).models || {}).length}). ` +
        `Collections(${app.db.collections.size}). ` +
        `syncName: ${app.db.sync?.name}. ` +
        `Storage: ${(app.db as any).options?.storage}`,
    );
  }
  return app;
}
