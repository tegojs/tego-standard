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

/**
 * In CI (file-based SQLite, fork reuse, limited resources) the framework's
 * install flow can occasionally skip or fail to create application tables
 * silently.  This function detects the problem and resolves it by running
 * a safe db.sync() — which uses CREATE TABLE IF NOT EXISTS — and then
 * verifies the critical tables actually exist.
 */
async function ensureTables(app: MockServer): Promise<void> {
  const tenantsCollection = app.db.getCollection('tenants');
  if (!tenantsCollection) {
    throw new Error(
      '[createTenantApp] "tenants" collection is not registered. ' +
        `Registered collections: ${Array.from(app.db.collections.keys()).join(', ')}`,
    );
  }
  // Check if the tenants table already exists in SQLite
  const check = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'",
  );
  if ((check[0] as any[]).length > 0) {
    return; // table exists, nothing to do
  }
  // Table missing — run db.sync() to create all registered tables
  await app.db.sync();
  // Verify
  const verify = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'",
  );
  if ((verify[0] as any[]).length === 0) {
    const allTables = await app.db.sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    throw new Error(
      '[createTenantApp] "tenants" table still missing after db.sync(). ' +
        `Tables in DB: ${(allTables[0] as any[]).map((r: any) => r.name).join(', ')}. ` +
        `Collections registered: ${Array.from(app.db.collections.keys()).join(', ')}. ` +
        `Sequelize models: ${Object.keys((app.db.sequelize as any).models || {}).join(', ')}. ` +
        `Storage: ${(app.db as any).options?.storage}`,
    );
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
    // createMockServer may have partially constructed the app and
    // registered it in AppSupervisor before failing.  Clean up so
    // the next test doesn't hit "app main already exists".
    await cleanupPreviousApp();
    throw err;
  }
  await ensureTables(app);
  return app;
}
