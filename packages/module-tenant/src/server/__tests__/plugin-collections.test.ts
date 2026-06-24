import type { MockServer } from '@tachybase/test';

import ExportPlugin from 'packages/plugin-action-export/src/server';

import { NAMESPACE } from '../../constants';
import { createTenantApp, ensureTenantBaseTables } from './utils';

describe('tenant plugin collections', () => {
  let app: MockServer;

  afterEach(async () => {
    await app.destroy();
  });

  it('should not define an explicit tenantUsers field on tenants collection', async () => {
    app = await createTenantApp();

    const tenantsCollection = app.db.getCollection('tenants');

    expect(tenantsCollection.getField('tenantUsers')).toBeFalsy();
    expect(tenantsCollection.getField('id')).toBeTruthy();
    expect(app.db.getCollection('users').getField('tenants')).toBeTruthy();
  });

  it('should use an isolated in-memory sqlite database for tenant app tests', async () => {
    app = await createTenantApp();

    expect((app.db as any).options.storage).toBe(':memory:');
  });

  it('should restore missing tenant base tables without unregistering action handlers', async () => {
    app = await createTenantApp({
      extraPlugins: [[ExportPlugin, { name: 'action-export', packageName: '@tachybase/plugin-action-export' }]],
    });

    await app.db.sequelize.getQueryInterface().dropTable('tenants');

    expect(await app.db.collectionExistsInDb('tenants')).toBe(false);
    const exportHandler = app.resourcer.getRegisteredHandler('export');

    await ensureTenantBaseTables(app);

    expect(await app.db.collectionExistsInDb('tenants')).toBe(true);
    expect(app.resourcer.getRegisteredHandler('export')).toBe(exportHandler);
  });

  it('should restore user tables needed by tenant-bound test users', async () => {
    app = await createTenantApp();

    await app.db.sequelize.getQueryInterface().dropTable('users');

    expect(await app.db.collectionExistsInDb('users')).toBe(false);

    await ensureTenantBaseTables(app);

    expect(await app.db.collectionExistsInDb('users')).toBe(true);

    await app.db.getRepository('tenants').create({
      values: [{ id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' }],
    });

    const user = await app.db.getRepository('users').create({
      values: {
        username: 'tenant_restored_user',
        email: 'tenant-restored-user@example.com',
        phone: '10000010014',
        password: '123456',
        roles: ['admin'],
        tenants: ['tenant-a'],
        defaultTenantId: 'tenant-a',
      },
    });

    expect(user.get('id')).toBeTruthy();
  });

  it('should register tenant management acl snippet', async () => {
    app = await createTenantApp();

    const snippet = app.acl.snippetManager.snippets.get('pm.tenant.manage');

    expect(snippet).toBeTruthy();
    expect(snippet.actions).toEqual(
      expect.arrayContaining(['tenants:*', 'tenantUsers:*', 'users:list', 'users:update']),
    );
  });

  it('should register locale resources with tenant namespace', async () => {
    app = await createTenantApp();

    expect(app.i18n.t('Tenant management', { lng: 'zh-CN', ns: NAMESPACE })).toBe('租户管理');
  });
});
