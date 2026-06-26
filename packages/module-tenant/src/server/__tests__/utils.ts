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

  // Post-create: verify tenants table exists. If not, create ALL tables
  // via queryInterface.createTable (bypasses sequelize.sync FK/afterSync
  // bugs). This is a defensive fallback for CI where the framework's
  // install flow silently fails to create application tables.
  const check = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'",
  );
  if ((check[0] as any[]).length === 0) {
    const qi = app.db.sequelize.getQueryInterface();
    for (const model of Object.values(app.db.sequelize.models) as any[]) {
      try {
        await qi.createTable(model.tableName, model.rawAttributes, {});
      } catch {
        /* already exists */
      }
    }
  }

  // Final verification
  const verify = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'",
  );
  if ((verify[0] as any[]).length === 0) {
    const allTables = await app.db.sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    throw new Error(
      `[createTenantApp] tenants STILL missing after fallback createTable. ` +
        `Tables(${(allTables[0] as any[]).length}): ${(allTables[0] as any[]).map((r: any) => r.name).join(',')}. ` +
        `Models(${Object.keys((app.db.sequelize as any).models || {}).length}). ` +
        `Storage: ${(app.db as any).options?.storage}`,
    );
  }
  return app;
}
