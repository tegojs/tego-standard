import type { MockServer } from '@tachybase/test';
import type { Model } from '@tego/server';

import { createTenantApp } from '../utils';

describe('administrator migration preview HTTP boundary', () => {
  let app: MockServer;
  let user: Model;
  const values = {
    dataSourceKey: 'main',
    collectionName: 'preview_documents',
    roleActions: [{ role: 'preview-reader', action: 'list' }],
  };
  const agent = (role: string) => app.agent().login(user).set('X-Role', role).set('X-Tenant-Id', 'preview-tenant');

  beforeAll(async () => {
    app = await createTenantApp(); // Explicit in-memory SQLite; never the restored business database.
    await app.db.getRepository('tenants').create({ values: { id: 'preview-tenant', name: 'Preview tenant' } });
    for (const [name, snippets] of [
      ['preview-manager', ['pm.tenant.manage']],
      ['preview-impersonator', ['pm.tenant.impersonate']],
      ['preview-reader', []],
    ] as const) {
      await app.db.getRepository('roles').create({ values: { name, snippets, strategy: { actions: ['view'] } } });
    }
    user = await app.db.getRepository('users').create({
      values: {
        username: 'preview-user',
        roles: ['preview-manager', 'preview-impersonator', 'preview-reader'],
        tenants: ['preview-tenant'],
        defaultTenantId: 'preview-tenant',
      },
    });
    await app.db.getRepository('collections').create({
      values: {
        name: 'preview_documents',
        tenancy: 'shared',
        fields: [{ name: 'title', type: 'string' }],
      },
      context: {},
    });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('previews migration through real password authentication without applying it', async () => {
    const password = 'preview-basic-manager-password';
    const authenticatedUser = await app.db.getRepository('users').create({
      values: {
        username: 'preview-basic-manager',
        password,
        roles: ['preview-manager'],
        tenants: ['preview-tenant'],
        defaultTenantId: 'preview-tenant',
      },
    });
    const signIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({
        account: authenticatedUser.get('username'),
        password,
      });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user.hasPassword).toBe(true);
    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', 'preview-manager')
      .set('X-Tenant-Id', 'preview-tenant')
      .resource('tenants')
      .previewAccessMigration({ values });

    expect(response.status).toBe(200);
    const metadata = await app.db.getRepository('collections').findOne({ filterByTk: values.collectionName });
    expect(response.body.data).toMatchObject({
      identity: {
        dataSourceKey: values.dataSourceKey,
        collectionName: values.collectionName,
        collectionKey: metadata.get('key'),
      },
      legacy: { tenancy: 'shared' },
      draft: { revision: 0, ownership: { enabled: false } },
      roleScopes: [{ role: 'preview-reader', treatment: 'no-direct-resource-grant' }],
    });
    expect(metadata.getDataValue('options')).not.toHaveProperty('tenantAccess');
    expect(app.db.getCollection(values.collectionName).options).not.toHaveProperty('tenantAccess');
  });

  it('uses the tenant management snippet and returns the normal data envelope', async () => {
    const response = await agent('preview-manager').resource('tenants').previewAccessMigration({ values });
    expect(response.status).toBe(200);
    const metadata = await app.db.getRepository('collections').findOne({ filterByTk: values.collectionName });
    expect(response.body.data).toMatchObject({
      identity: {
        dataSourceKey: values.dataSourceKey,
        collectionName: values.collectionName,
        collectionKey: metadata.get('key'),
      },
      legacy: { tenancy: 'shared' },
      draft: { revision: 0, ownership: { enabled: false } },
      roleScopes: [{ role: 'preview-reader', treatment: 'no-direct-resource-grant' }],
    });
    expect(app.db.getCollection(values.collectionName).options).not.toHaveProperty('tenantAccess');
  });

  it.each(['preview-reader', 'preview-impersonator'])(
    'denies switching the same user to %s, even with ordinary viewing permission',
    async (role) => {
      const response = await agent(role).resource('tenants').previewAccessMigration({ values });
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data.draft');
    },
  );

  it('denies anonymous preview requests', async () => {
    const response = await app.agent().resource('tenants').previewAccessMigration({ values });
    expect([401, 403]).toContain(response.status);
    expect(response.body).not.toHaveProperty('data.draft');
  });

  it('preserves translated validation errors in the normal error envelope', async () => {
    const response = await agent('preview-manager')
      .set('X-Locale', 'zh-CN')
      .resource('tenants')
      .previewAccessMigration({ values: { ...values, tenantAccess: {} } });
    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({
      code: 'INVALID_ACCESS_CONFIG_WRITE',
      message: '无法预览此表。请检查所选数据表及角色操作。',
    });
  });
});
