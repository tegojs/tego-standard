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

  // Diagnostic: list tables and verify tenants exists
  try {
    const [rows] = await app.db.sequelize.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tenants'");
    if (!(rows as any[]).length) {
      const [allTables] = await app.db.sequelize.query("SELECT name FROM sqlite_master WHERE type='table'");
      console.error(
        '[createTenantApp] tenants MISSING. Tables:',
        (allTables as any[]).map((r: any) => r.name),
      );
      console.error('[createTenantApp] collections:', Array.from(app.db.collections.keys()).slice(0, 10));
      console.error('[createTenantApp] sequelize models:', Object.keys(app.db.sequelize.models));
    }
  } catch (e) {
    console.error('[createTenantApp] diagnostic failed:', e.message);
  }

  return app;
}
