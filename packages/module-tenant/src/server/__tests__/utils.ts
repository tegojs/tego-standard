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
 * install flow can silently fail to create some or all application tables.
 * The failure is not limited to "tenants" — "collectionCategories" and
 * others can be missing too, which then crashes sort-field's afterSync
 * needInit during the actual test.
 *
 * We therefore unconditionally run a raw Sequelize two-pass model.sync()
 * for EVERY registered model.  We use model.sync() (CREATE TABLE IF NOT
 * EXISTS) directly instead of tachybase's db.sync(): db.sync() bridges
 * sequelize's afterSync into the `{model}.afterSync` database event, which
 * sort-field listens to and which queries other tables that may not exist
 * yet — causing the exact crash we are guarding against.  Raw model.sync()
 * also fires afterSync, but only after that model's own table is created,
 * so sort-field's count of its own table succeeds.
 */
async function ensureTables(app: MockServer): Promise<void> {
  const tenantsCollection = app.db.getCollection('tenants');
  if (!tenantsCollection) {
    throw new Error(
      '[createTenantApp] "tenants" collection is not registered. ' +
        `Registered collections: ${Array.from(app.db.collections.keys()).join(', ')}`,
    );
  }
  try {
    await app.db.sequelize.query('PRAGMA foreign_keys = OFF');
    const models = Object.values(app.db.sequelize.models);
    // Two-pass sync handles FK ordering between models
    for (const m of models) {
      try {
        await m.sync();
      } catch {
        /* FK dep not yet created */
      }
    }
    for (const m of models) {
      try {
        await m.sync();
      } catch {
        /* still fails */
      }
    }
    await app.db.sequelize.query('PRAGMA foreign_keys = ON');
  } catch {
    /* PRAGMA unsupported */
  }
  // Verify the critical table exists
  const verify = await app.db.sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'",
  );
  if ((verify[0] as any[]).length === 0) {
    const allTables = await app.db.sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    throw new Error(
      '[createTenantApp] "tenants" table still missing after fallback sync. ' +
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
