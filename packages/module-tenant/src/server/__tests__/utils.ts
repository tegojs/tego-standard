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

  // In some CI environments (Node 20 + Linux + sqlite3 prebuild), the
  // db.sync() inside pm.install() can silently skip newly-registered
  // collections.  A targeted sync after server creation prevents
  // "no such table" errors when the test accesses tenant data.
  // In some CI environments (Node 20 + Linux + sqlite3 prebuild), the
  // db.sync() inside pm.install() can silently skip newly-registered
  // collections.  A full sync after server creation prevents
  // "no such table" errors when the test accesses tenant data.
  // Disable FK checks to avoid collectionCategories FK ordering issues.
  try {
    await app.db.sequelize.query('PRAGMA foreign_keys = OFF');
    await app.db.sync();
    await app.db.sequelize.query('PRAGMA foreign_keys = ON');
  } catch (e) {
    app.logger?.warn?.('db.sync() in createTenantApp failed', e);
  }

  return app;
}
