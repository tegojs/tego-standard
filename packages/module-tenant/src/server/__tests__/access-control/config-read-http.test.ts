import type { MockServer } from '@tachybase/test';
import type { Model } from '@tego/server';

import { createTenantApp } from '../utils';

describe('administrator access configuration read HTTP boundary', () => {
  let app: MockServer;
  let user: Model;
  const values = { dataSourceKey: 'main', collectionName: 'config_documents' };
  const agent = (role: string) => app.agent().login(user).set('X-Role', role).set('X-Tenant-Id', 'config-tenant');

  beforeAll(async () => {
    app = await createTenantApp(); // In-memory SQLite; never the restored business database.
    await app.db.getRepository('tenants').create({ values: { id: 'config-tenant', name: 'Configuration tenant' } });
    for (const [name, snippets] of [
      ['config-manager', ['pm.tenant.manage']],
      ['config-impersonator', ['pm.tenant.impersonate']],
      ['config-reader', []],
    ] as const) {
      await app.db.getRepository('roles').create({ values: { name, snippets, strategy: { actions: ['view'] } } });
    }
    user = await app.db.getRepository('users').create({
      values: {
        username: 'configuration-user',
        roles: ['config-manager', 'config-impersonator', 'config-reader'],
        tenants: ['config-tenant'],
        defaultTenantId: 'config-tenant',
      },
    });
    await app.db.getRepository('collections').create({
      values: { name: values.collectionName, tenancy: 'shared', fields: [{ name: 'title', type: 'string' }] },
      context: {},
    });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('lets the management role read an explicit unconfigured result without migrating the table', async () => {
    const response = await agent('config-manager').resource('tenants').readAccessConfig({ values });
    expect(response.status).toBe(200);
    const metadata = await app.db.getRepository('collections').findOne({ filterByTk: values.collectionName });
    expect(response.body.data).toEqual({
      identity: { ...values, collectionKey: metadata.get('key') },
      config: null,
    });
    expect(app.db.getCollection(values.collectionName).options).not.toHaveProperty('tenantAccess');
    expect(metadata.getDataValue('options')).not.toHaveProperty('tenantAccess');
  });

  it.each(['config-reader', 'config-impersonator'])('denies %s without management permission', async (role) => {
    const response = await agent(role).resource('tenants').readAccessConfig({ values });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data.config');
  });

  it('denies anonymous callers', async () => {
    const response = await app.agent().resource('tenants').readAccessConfig({ values });
    expect([401, 403]).toContain(response.status);
    expect(response.body).not.toHaveProperty('data.config');
  });

  it('translates invalid input while preserving the validation code', async () => {
    const response = await agent('config-manager')
      .set('X-Locale', 'zh-CN')
      .resource('tenants')
      .readAccessConfig({ values: { ...values, tenantAccess: {} } });
    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({
      code: 'INVALID_ACCESS_CONFIG_WRITE',
      message: '无法读取访问规则。请检查所选数据源及数据表。',
    });
  });
});
