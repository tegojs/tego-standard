import type { MockServer } from '@tachybase/test';
import type { Model } from '@tego/server';

import { createTenantApp } from '../utils';

describe('administrator access rule validation HTTP boundary', () => {
  let app: MockServer;
  let user: Model;
  const config = { schemaVersion: 1, revision: 0, ownership: { enabled: false }, rules: [] };
  const values = { dataSourceKey: 'main', collectionName: 'validation_documents', config };
  const agent = (role: string) => app.agent().login(user).set('X-Role', role).set('X-Tenant-Id', 'validation-tenant');

  beforeAll(async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({ values: { id: 'validation-tenant', name: 'Validation tenant' } });
    for (const [name, snippets] of [
      ['validation-manager', ['pm.tenant.manage']],
      ['validation-impersonator', ['pm.tenant.impersonate']],
      ['validation-reader', []],
    ] as const) {
      await app.db.getRepository('roles').create({ values: { name, snippets, strategy: { actions: ['view'] } } });
    }
    user = await app.db.getRepository('users').create({
      values: {
        username: 'validation-user',
        roles: ['validation-manager', 'validation-impersonator', 'validation-reader'],
        tenants: ['validation-tenant'],
        defaultTenantId: 'validation-tenant',
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

  it('validates a configuration through real password authentication without applying it', async () => {
    const password = 'validation-basic-manager-password';
    const authenticatedUser = await app.db.getRepository('users').create({
      values: {
        username: 'validation-basic-manager',
        password,
        roles: ['validation-manager'],
        tenants: ['validation-tenant'],
        defaultTenantId: 'validation-tenant',
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
      .set('X-Role', 'validation-manager')
      .set('X-Tenant-Id', 'validation-tenant')
      .resource('tenants')
      .validateAccessConfig({ values });

    expect(response.status).toBe(200);
    const record = await app.db.getRepository('collections').findOne({ filterByTk: values.collectionName });
    expect(response.body.data).toEqual({
      identity: {
        dataSourceKey: 'main',
        collectionName: values.collectionName,
        collectionKey: record.get('key'),
      },
      config,
    });
    expect(record.getDataValue('options')).not.toHaveProperty('tenantAccess');
    expect(app.db.getCollection(values.collectionName).options).not.toHaveProperty('tenantAccess');
  });

  it('validates without saving, incrementing a revision or activating a collection', async () => {
    const response = await agent('validation-manager').resource('tenants').validateAccessConfig({ values });
    expect(response.status).toBe(200);
    const record = await app.db.getRepository('collections').findOne({ filterByTk: values.collectionName });
    expect(response.body.data).toEqual({
      identity: { dataSourceKey: 'main', collectionName: values.collectionName, collectionKey: record.get('key') },
      config,
    });
    expect(record.getDataValue('options')).not.toHaveProperty('tenantAccess');
    expect(app.db.getCollection(values.collectionName).options).not.toHaveProperty('tenantAccess');
  });

  it.each(['validation-reader', 'validation-impersonator'])('denies %s without management permission', async (role) => {
    const response = await agent(role).resource('tenants').validateAccessConfig({ values });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data.config');
  });

  it('denies anonymous callers', async () => {
    const response = await app.agent().resource('tenants').validateAccessConfig({ values });
    expect([401, 403]).toContain(response.status);
  });

  it('translates validation errors without leaking internal rule details', async () => {
    const response = await agent('validation-manager')
      .set('X-Locale', 'zh-CN')
      .resource('tenants')
      .validateAccessConfig({ values: { ...values, config: { ...config, schemaVersion: 99 } } });
    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({
      code: 'INVALID_ACCESS_RULE',
      message: '访问规则校验失败。请检查规则条件和数据表字段。',
    });
  });
});
