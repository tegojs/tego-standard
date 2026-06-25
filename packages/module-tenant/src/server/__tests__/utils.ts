import { createMockServer, MockServer } from '@tachybase/test';
import { AppSupervisor, Plugin } from '@tego/server';

import PluginTenantServer from '..';

/**
 * Remove any leftover app from a previous failed test.
 * When createMockServer throws mid-flight the app may already be
 * registered in AppSupervisor (the constructor calls addApp before
 * install/start).  The next test would then hit
 * "app main already exists".  This helper prevents that cascade.
 */
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

export async function createTenantApp(options: { extraPlugins?: any[] } = {}): Promise<MockServer> {
  const { extraPlugins = [] } = options;

  // Guarantee no stale "main" app from a previous failed test
  await cleanupPreviousApp();

  class TestAuthStatusPlugin extends Plugin {
    async load() {
      if (!this.app.authManager.userStatusService) {
        this.app.authManager.setUserStatusService({
          async checkUserStatus() {
            return {
              allowed: true,
              status: 'active',
              isExpired: false,
            };
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
      // Disable FK constraints: the tenant plugin's ensureTenantIdField
      // dynamically injects FK references that change sequelize.sync()'s
      // topological sort.  With FK enabled the serial sync loop aborts on
      // the first FK error and leaves most application tables uncreated.
      // Disabling FK lets sync create all tables regardless of order.
      // Tests don't rely on SQLite-level FK enforcement (tachybase uses
      // application-level association logic).
      database: { dialect: 'sqlite', foreignKeys: false },
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
  } catch (err) {
    await cleanupPreviousApp();
    throw err;
  }

  // Diagnostic: verify FK status and table count (visible as test failure in CI)
  const fkCheck = await app.db.sequelize.query('PRAGMA foreign_keys');
  const fkStatus = (fkCheck[0] as any[])[0];
  const tableCheck = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  const tableNames = (tableCheck[0] as any[]).map((r: any) => r.name);
  if (!tableNames.includes('tenants')) {
    throw new Error(
      `[createTenantApp] tenants table missing. FK=${JSON.stringify(fkStatus)} ` +
        `DB.options.foreignKeys=${(app.db as any).options?.foreignKeys} ` +
        `sequelize.options.foreignKeys=${(app.db.sequelize as any).options?.foreignKeys} ` +
        `Tables(${tableNames.length}): ${tableNames.join(',')} ` +
        `Collections(${app.db.collections.size}): ${Array.from(app.db.collections.keys()).slice(0, 10).join(',')}... ` +
        `Storage: ${(app.db as any).options?.storage}`,
    );
  }
  return app;
}
