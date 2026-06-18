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
  // collections.  Sync the tenant tables individually to prevent
  // "no such table" errors when the test accesses tenant data.
  // We avoid a full db.sync() because some collections (e.g.
  // collectionCategories) have cross-table dependencies that fail
  // when synced in isolation.
  try {
    const tenantModel = app.db.getModel('tenants');
    if (tenantModel) {
      await tenantModel.sync();
    }
    const tenantUsersModel = app.db.getModel('tenantUsers');
    if (tenantUsersModel) {
      await tenantUsersModel.sync();
    }
  } catch {
    // Tables may already exist from a prior install — ignore.
  }

  return app;
}
