import { createMockServer, MockServer } from '@tachybase/test';
import { Plugin } from '@tego/server';

import PluginTenantServer from '..';

export async function createTenantApp(options: { extraPlugins?: any[] } = {}): Promise<MockServer> {
  const { extraPlugins = [] } = options;

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

  const app = await createMockServer({
    registerActions: true,
    acl: true,
    plugins: [
      'acl',
      'error-handler',
      'users',
      'ui-schema-storage',
      'collection-manager',
      'auth',
      'data-source-manager',
      [PluginTenantServer, { name: 'tenant', packageName: '@tachybase/module-tenant' }],
      ...extraPlugins,
      TestAuthStatusPlugin,
    ],
  });

  // Guarantee all tables exist. In CI the framework's internal db.sync()
  // runs before plugin loadCollections(), so application tables may be
  // missing. We need FK checks off for the sync because
  // collectionCategories has a FK to collections and they may be synced
  // in the wrong order. Use a transaction to ensure PRAGMA and sync
  // share the same SQLite connection (connection-pool safe).
  const sequelize = app.db.sequelize;
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query('PRAGMA foreign_keys = OFF', { transaction: t });
      await app.db.sync({ transaction: t });
      await sequelize.query('PRAGMA foreign_keys = ON', { transaction: t });
    });
  } catch {
    // If full sync fails (e.g. FK ordering), fall back to per-model sync
    // with two passes: first pass creates what it can, second pass retries
    // models whose FK deps were missing.
    try {
      await sequelize.query('PRAGMA foreign_keys = OFF');
      const models = Object.values(sequelize.models);
      for (const m of models) {
        try {
          await m.sync();
        } catch {
          /* FK dep missing */
        }
      }
      for (const m of models) {
        try {
          await m.sync();
        } catch {
          /* still fails */
        }
      }
      await sequelize.query('PRAGMA foreign_keys = ON');
    } catch {
      /* complete failure */
    }
  }

  return app;
}
