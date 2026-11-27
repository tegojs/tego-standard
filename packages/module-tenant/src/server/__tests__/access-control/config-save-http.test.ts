import type { MockServer } from '@tachybase/test';
import type { Model } from '@tego/server';

import { createTenantApp } from '../utils';

describe('administrator access rule save HTTP boundary', () => {
  let app: MockServer;
  let user: Model;
  const identity = { dataSourceKey: 'main', collectionName: 'save_documents' };
  const config = { schemaVersion: 1, revision: 0, ownership: { enabled: true }, rules: [] };
  let values: Record<string, unknown> = { ...identity, config };
  const agent = (role: string) => app.agent().login(user).set('X-Role', role).set('X-Tenant-Id', 'save-tenant');

  beforeAll(async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({ values: { id: 'save-tenant', name: 'Save tenant' } });
    for (const [name, snippets] of [
      ['save-manager', ['pm.tenant.manage']],
      ['save-reader', []],
    ] as const) {
      await app.db.getRepository('roles').create({ values: { name, snippets, strategy: { actions: ['view'] } } });
    }
    user = await app.db.getRepository('users').create({
      values: {
        username: 'save-user',
        roles: ['save-manager', 'save-reader'],
        tenants: ['save-tenant'],
        defaultTenantId: 'save-tenant',
      },
    });
    await app.db.getRepository('collections').create({
      values: { name: identity.collectionName, tenancy: 'shared', fields: [{ name: 'title', type: 'string' }] },
      context: {},
    });
    const collection = await app.db.getRepository('collections').findOne({ filterByTk: identity.collectionName });
    values = { ...values, collectionKey: collection.get('key') };
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('requires tenant management permission to save', async () => {
    const response = await agent('save-reader').resource('tenants').saveAccessConfig({ values });

    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    const record = await app.db.getRepository('collections').findOne({ filterByTk: identity.collectionName });
    expect(record.getDataValue('options')).not.toHaveProperty('tenantAccess');
  });

  it('denies anonymous callers', async () => {
    const response = await app.agent().resource('tenants').saveAccessConfig({ values });

    expect([401, 403]).toContain(response.status);
    expect(response.body).not.toHaveProperty('data');
  });

  it('rejects invalid configurations without persisting them', async () => {
    const response = await agent('save-manager')
      .resource('tenants')
      .saveAccessConfig({ values: { ...values, config: { ...config, schemaVersion: 99 } } });

    expect(response.status).toBe(400);
    const record = await app.db.getRepository('collections').findOne({ filterByTk: identity.collectionName });
    expect(record.getDataValue('options')).not.toHaveProperty('tenantAccess');
  });

  it('rejects a save when the collection identity changed after opening the draft', async () => {
    const response = await agent('save-manager')
      .resource('tenants')
      .saveAccessConfig({ values: { ...values, collectionKey: 'recreated-collection' } });

    expect(response.status).toBe(409);
    const record = await app.db.getRepository('collections').findOne({ filterByTk: identity.collectionName });
    expect(record.getDataValue('options')).not.toHaveProperty('tenantAccess');
  });

  it('saves a validated revision for a manager and exposes it through the read action', async () => {
    const response = await agent('save-manager').resource('tenants').saveAccessConfig({ values });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      identity: { ...identity, collectionKey: expect.any(String) },
      config: { ...config, revision: 1 },
    });
    const record = await app.db.getRepository('collections').findOne({ filterByTk: identity.collectionName });
    expect(record.getDataValue('options').tenantAccess).toEqual({ ...config, revision: 1 });
    const history = await app.db.getRepository('tenantAccessRevisions').findOne({
      filter: { collectionName: identity.collectionName, revision: 1 },
    });
    expect(history).toMatchObject({ actorUserId: String(user.get('id')), config: { ...config, revision: 1 } });

    const read = await agent('save-manager').resource('tenants').readAccessConfig({ values: identity });
    expect(read.status).toBe(200);
    expect(read.body.data.config).toEqual({ ...config, revision: 1 });

    const stale = await agent('save-manager').resource('tenants').saveAccessConfig({ values });
    expect(stale.status).toBe(409);
    expect(stale.body.errors[0]).toMatchObject({ code: 'ACCESS_CONFIG_CONFLICT' });
  });

  it('keeps metadata and audit mutations behind the versioned save service', async () => {
    const readBeforeSave = await agent('save-manager').resource('tenants').readAccessConfig({ values: identity });
    const baseConfig = readBeforeSave.body.data.config ?? config;
    const saved = await agent('save-manager')
      .resource('tenants')
      .saveAccessConfig({ values: { ...values, config: baseConfig } });
    expect(saved.status).toBe(200);
    const savedConfig = saved.body.data.config;
    const collectionRecord = await app.db.getRepository('collections').findOne({ filterByTk: identity.collectionName });
    const options = collectionRecord.getDataValue('options');
    await expect(
      app.db.getRepository('collections').update({
        filterByTk: identity.collectionName,
        values: { options: { ...options, tenantAccess: { ...options.tenantAccess, revision: 99 } } },
      }),
    ).rejects.toThrow();

    const history = await app.db.getRepository('tenantAccessRevisions').findOne({
      filter: { collectionName: identity.collectionName, revision: savedConfig.revision },
    });
    await expect(
      app.db.getRepository('tenantAccessRevisions').update({
        filterByTk: history.get('id'),
        values: { config: { ...config, revision: 99 } },
      }),
    ).rejects.toThrow();
    await expect(
      app.db.getRepository('tenantAccessRevisions').destroy({ filterByTk: history.get('id') }),
    ).rejects.toThrow();

    const read = await agent('save-manager').resource('tenants').readAccessConfig({ values: identity });
    expect(read.body.data.config).toEqual(savedConfig);
    expect(await app.db.getRepository('tenantAccessRevisions').count()).toBe(savedConfig.revision);
  });
});
