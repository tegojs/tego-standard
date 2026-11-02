import type { MockServer } from '@tachybase/test';
import type { Model } from '@tego/server';

import { accessConfigHistory } from '../../access-control/config-history';
import { accessCollectionKey, AccessConfigStore, registerAccessConfigGuards } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import type { AccessConfig } from '../../access-control/types';
import { createTenantApp } from '../utils';
import { configFor } from './fixtures';

describe('administrator configuration revision HTTP boundary', () => {
  let app: MockServer;
  let user: Model;
  let original: AccessConfig;
  let identity: { dataSourceKey: string; collectionKey: string; collectionName: string };
  const values = { dataSourceKey: 'main', collectionName: 'revision_documents' };
  const agent = (role = 'revision-manager') =>
    app.agent().login(user).set('X-Role', role).set('X-Tenant-Id', 'revision-tenant');

  beforeAll(async () => {
    app = await createTenantApp();
    await app.db.getRepository('tenants').create({ values: { id: 'revision-tenant', name: 'Revision tenant' } });
    for (const [name, snippets] of [
      ['revision-manager', ['pm.tenant.manage']],
      ['revision-reader', []],
      ['revision-impersonator', ['pm.tenant.impersonate']],
    ] as const)
      await app.db.getRepository('roles').create({ values: { name, snippets, strategy: { actions: ['view'] } } });
    user = await app.db.getRepository('users').create({
      values: {
        username: 'revision-user',
        roles: ['revision-manager', 'revision-reader', 'revision-impersonator'],
        tenants: ['revision-tenant'],
        defaultTenantId: 'revision-tenant',
      },
    });
    const record = await app.db.getRepository('collections').create({
      values: { name: values.collectionName, tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      context: {},
    });
    identity = { ...values, collectionKey: record.get('key') };
    const collection = app.db.getCollection(values.collectionName);
    await app.db.collection(accessConfigHistory).model.sync(); // Explicit test setup, never automatic production install.
    registerAccessConfigGuards(app.db);
    const store = new AccessConfigStore(app.db, () =>
      resolveModelMetadata(collection, { resolveCollectionKey: () => accessCollectionKey(identity) }),
    );
    original = await store.save(
      identity,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 0 },
      { userId: user.get('id') },
    );
    await store.save(identity, { ...original, rules: [] }, { userId: user.get('id') });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('lists only bounded revision summaries for the manager', async () => {
    const response = await agent()
      .resource('tenants')
      .listAccessConfigRevisions({ values: { ...values, limit: 1 } });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      identity,
      revisions: [{ revision: 2, actorUserId: String(user.get('id')), savedAt: expect.any(String) }],
      nextBefore: 2,
    });
    const next = await agent()
      .resource('tenants')
      .listAccessConfigRevisions({ values: { ...values, beforeRevision: 2 } });
    expect(next.status).toBe(200);
    expect(next.body.data).toMatchObject({ revisions: [{ revision: 1 }], nextBefore: null });
  });

  it('previews a current-base restored draft without saving or activating anything', async () => {
    const metadata = app.db.getRepository('collections');
    const before = (await metadata.findOne({ filterByTk: values.collectionName })).getDataValue('options');
    const response = await agent()
      .resource('tenants')
      .previewAccessConfigRevision({ values: { ...values, revision: 1 } });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ identity, sourceRevision: 1, config: { ...original, revision: 2 } });
    expect((await metadata.findOne({ filterByTk: values.collectionName })).getDataValue('options')).toEqual(before);
    expect(await app.db.getRepository('tenantAccessRevisions').count()).toBe(2);
    expect(app.db.getCollection(values.collectionName).options.tenantAccess).toEqual(before.tenantAccess);
  });

  it.each(['revision-reader', 'revision-impersonator'])('denies %s both history operations', async (role) => {
    const client = agent(role).resource('tenants');
    expect((await client.listAccessConfigRevisions({ values })).status).toBe(403);
    expect((await client.previewAccessConfigRevision({ values: { ...values, revision: 1 } })).status).toBe(403);
  });

  it('does not expose history or drafts anonymously', async () => {
    const client = app.agent().resource('tenants');
    for (const response of [
      await client.listAccessConfigRevisions({ values }),
      await client.previewAccessConfigRevision({ values: { ...values, revision: 1 } }),
    ]) {
      expect([401, 403]).toContain(response.status);
      expect(response.body).not.toHaveProperty('data');
    }
  });

  it.each([
    { ...values, limit: 0 },
    { ...values, limit: 101 },
    { ...values, beforeRevision: '1' },
    { ...values, collectionKey: 'forged' },
    { ...values, config: {} },
  ])('rejects invalid list input %j', async (input) => {
    const response = await agent().resource('tenants').listAccessConfigRevisions({ values: input });
    expect(response.status).toBe(400);
    expect(response.body.errors[0].code).toBe('INVALID_ACCESS_CONFIG_WRITE');
  });

  it.each([0, '1', null, -1])('rejects invalid preview revision %s', async (revision) => {
    const response = await agent()
      .resource('tenants')
      .previewAccessConfigRevision({ values: { ...values, revision } });
    expect(response.status).toBe(400);
    expect(response.body.errors[0].code).toBe('INVALID_ACCESS_CONFIG_WRITE');
  });

  it('reports a missing revision without returning another version or writing history', async () => {
    const response = await agent()
      .set('X-Locale', 'zh-CN')
      .resource('tenants')
      .previewAccessConfigRevision({ values: { ...values, revision: 99 } });
    expect(response.status).toBe(404);
    expect(response.body.errors[0].code).toBe('ACCESS_COLLECTION_NOT_FOUND');
    expect(response.body.errors[0].message).toBe('所选历史版本或数据表不可用，请刷新后重试。');
    expect(response.body).not.toHaveProperty('data.config');
    expect(await app.db.getRepository('tenantAccessRevisions').count()).toBe(2);
  });
});
