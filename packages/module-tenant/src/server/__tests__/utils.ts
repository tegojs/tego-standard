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

  // In CI the framework's pm.install() calls db.sync() BEFORE plugin
  // loadCollections(), so application tables are never created.
  // SyncPlugin is listed last so its install() runs after all other
  // plugins have been installed and their collections registered.
  class SyncPlugin extends Plugin {
    async install() {
      // Sync all registered models to create their tables.
      // Two passes with FK disabled: first pass creates what it can,
      // second pass retries models whose FK deps were missing.
      // Individual model.sync errors are swallowed to prevent
      // cascade failures.
      try {
        await this.db.sequelize.query('PRAGMA foreign_keys = OFF');
        const models = Object.values(this.db.sequelize.models);
        for (const m of models) {
          try {
            await m.sync();
          } catch {
            /* FK dep or other */
          }
        }
        for (const m of models) {
          try {
            await m.sync();
          } catch {
            /* still fails */
          }
        }
        await this.db.sequelize.query('PRAGMA foreign_keys = ON');
      } catch {
        /* pragma unsupported — ignore */
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
      SyncPlugin,
    ],
  });

  // Belt-and-suspenders: if SyncPlugin.install was skipped (e.g.
  // isInstalled returned true in CI), ensure tenant tables exist.
  // Only sync the specific models we need — not all models, to avoid
  // interfering with plugin action registration.
  for (const name of ['tenants', 'tenantUsers']) {
    const m = app.db.sequelize.models?.[name];
    if (m) {
      try {
        await m.sync();
      } catch {
        /* already exists */
      }
    }
  }

  return app;
}
