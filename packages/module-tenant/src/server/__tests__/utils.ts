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

  // Guarantee tenant tables exist by syncing the specific models.
  // In CI the framework's internal db.sync() may run before plugin
  // collections are registered; model.sync() targets one table at a
  // time and always uses the live database handle.
  await app.db.sequelize.query('PRAGMA foreign_keys = OFF');
  for (const name of ['tenants', 'tenantUsers']) {
    const model = app.db.sequelize.models?.[name];
    if (model) {
      await model.sync();
    }
  }
  await app.db.sequelize.query('PRAGMA foreign_keys = ON');

  return app;
}
