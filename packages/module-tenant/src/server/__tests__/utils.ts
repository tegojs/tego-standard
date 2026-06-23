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

  // SyncPlugin runs inside pm.install() after all other plugins have
  // registered their collections.  This is the only reliable place to
  // create application tables because pm.install() own db.sync() runs
  // BEFORE loadCollections().
  //
  // We also force in-memory SQLite (no storage file) so that
  // isInstalled() always returns false on a fresh createMockServer
  // call — preventing pm.install from being skipped when a previous
  // test left a stale database file (CI uses file-based SQLite via
  // setupServerTestEnvironment).
  class SyncPlugin extends Plugin {
    async install() {
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

  return createMockServer({
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
      [PluginTenantServer, { name: 'tenant', packageName: '@tachybase/module-tenant' }],
      ...extraPlugins,
      TestAuthStatusPlugin,
      SyncPlugin,
    ],
  });
}
