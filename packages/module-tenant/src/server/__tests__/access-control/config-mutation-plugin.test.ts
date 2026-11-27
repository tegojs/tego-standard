import type { MockServer } from '@tachybase/test';
import type { Collection, Model } from '@tego/server';

import { accessConfigHistory } from '../../access-control/config-history';
import { accessCollectionKey, AccessConfigStore, registerAccessConfigGuards } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { createTenantApp } from '../utils';
import { configFor } from './fixtures';

const draft = () => ({ ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 0 });

describe('configuration guard with real collection management', () => {
  let app: MockServer;
  let user: Model;
  let collection: Collection;
  let store: AccessConfigStore;
  let identity: { dataSourceKey: string; collectionKey: string; collectionName: string };
  let sequence = 0;
  const agent = (role = 'root') =>
    app.agent().login(user).set('X-Role', role).set('X-Tenant-Id', 'metadata-guard-tenant');

  beforeAll(async () => {
    app = await createTenantApp(); // The application's actual plugins, isolated in-memory SQLite.
    await app.db
      .getRepository('tenants')
      .create({ values: { id: 'metadata-guard-tenant', name: 'Metadata guard tenant' } });
    for (const [name, snippets] of [
      ['metadata-reader', []],
      ['metadata-impersonator', ['pm.tenant.impersonate']],
      ['metadata-manager', ['pm.tenant.manage']],
    ] as const) {
      await app.db.getRepository('roles').create({ values: { name, snippets, strategy: { actions: ['view'] } } });
    }
    user = await app.db.getRepository('users').create({
      values: {
        username: 'metadata-guard-user',
        roles: ['root', 'metadata-reader', 'metadata-impersonator', 'metadata-manager'],
        tenants: ['metadata-guard-tenant'],
        defaultTenantId: 'metadata-guard-tenant',
      },
    });
    await app.db.collection(accessConfigHistory).model.sync();
    registerAccessConfigGuards(app.db);
  });
  afterAll(async () => {
    await app?.destroy();
  });

  beforeEach(async () => {
    const name = `metadata_guard_documents_${++sequence}`;
    const record = await app.db.getRepository('collections').create({
      values: { name, title: 'Original', tenancy: 'shared', fields: [{ name: 'name', type: 'string' }] },
      context: {},
    });
    collection = app.db.getCollection(name);
    identity = { dataSourceKey: 'main', collectionKey: record.get('key'), collectionName: name };
    // The fixture contains scalar fields only; no synthetic identities for related models.
    store = new AccessConfigStore(app.db, () =>
      resolveModelMetadata(collection, {
        resolveCollectionKey: (target) => {
          if (target !== collection) throw new Error('Unexpected metadata fixture relation');
          return accessCollectionKey(identity);
        },
      }),
    );
  });
  const metadata = () => app.db.getRepository('collections').findOne({ filterByTk: identity.collectionName });
  const revisions = () =>
    app.db.getRepository('tenantAccessRevisions').count({ filter: { collectionKey: identity.collectionKey } });
  const update = (values: object) =>
    agent().resource('collections').update({ filterByTk: identity.collectionName, values });

  it.each(['metadata-reader', 'metadata-impersonator'])(
    'keeps %s schema reads available without granting configuration management',
    async (role) => {
      await store.save(identity, draft(), { userId: user.get('id') });
      const schema = await agent(role)
        .resource('collections')
        .list({ filter: { name: identity.collectionName }, paginate: false, appends: ['fields'] });
      expect(schema.status).toBe(200);
      expect(schema.body.data).toHaveLength(1);
      expect(schema.body.data[0]).toMatchObject({ name: identity.collectionName, title: 'Original' });
      expect(schema.body.data[0].fields).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'name' })]));
      const config = await agent(role)
        .resource('tenants')
        .readAccessConfig({
          values: { dataSourceKey: identity.dataSourceKey, collectionName: identity.collectionName },
        });
      expect(config.status).toBe(403);
      expect(config.body).not.toHaveProperty('data');
    },
  );

  it('denies anonymous audit reads after a configuration revision exists', async () => {
    await store.save(identity, draft(), { userId: user.get('id') });
    const revision = await app.db.getRepository('tenantAccessRevisions').findOne({
      filter: { collectionKey: identity.collectionKey },
    });
    const resource = app.agent().resource('tenantAccessRevisions');
    for (const response of [
      await resource.list({ filter: { collectionKey: identity.collectionKey } }),
      await resource.get({ filterByTk: revision.get('id') }),
      await resource.count({ filter: { collectionKey: identity.collectionKey } }),
    ]) {
      expect([401, 403]).toContain(response.status);
      expect(response.body).not.toHaveProperty('data');
    }
  });

  it.each(['metadata-reader', 'metadata-impersonator', 'metadata-manager'])(
    'does not grant %s audit history through the business view strategy',
    async (role) => {
      await store.save(identity, draft(), { userId: user.get('id') });
      const revision = await app.db.getRepository('tenantAccessRevisions').findOne({
        filter: { collectionKey: identity.collectionKey },
      });
      const resource = agent(role).resource('tenantAccessRevisions');
      for (const response of [
        await resource.list({ filter: { collectionKey: identity.collectionKey } }),
        await resource.get({ filterByTk: revision.get('id') }),
        await resource.count({ filter: { collectionKey: identity.collectionKey } }),
      ]) {
        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('data');
      }
    },
  );

  it('lets a management role read saved configuration while preserving internal audit reads', async () => {
    const config = await store.save(identity, draft(), { userId: user.get('id') });
    const response = await agent('metadata-manager')
      .resource('tenants')
      .readAccessConfig({ values: { dataSourceKey: identity.dataSourceKey, collectionName: identity.collectionName } });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ identity, config });
    const audit = await agent()
      .resource('tenantAccessRevisions')
      .list({ filter: { collectionKey: identity.collectionKey } });
    expect(audit.status).toBe(200);
    expect(audit.body.data).toHaveLength(1);
    expect(audit.body.data[0]).toMatchObject({ revision: 1, config, actorUserId: String(user.get('id')) });
  });

  it('keeps ordinary HTTP option editing available on an unconfigured table', async () => {
    const response = await update({ title: 'Edited', options: { color: 'blue' } });
    expect(response.status).toBe(200);
    expect((await metadata()).getDataValue('options')).toMatchObject({ color: 'blue' });
    expect(collection.options).toMatchObject({ title: 'Edited', color: 'blue', tenancy: 'shared' });
    expect(await store.read(identity)).toBeNull();
    expect(await revisions()).toBe(0);
  });

  it('keeps ordinary HTTP collection creation available without copying access rules', async () => {
    const name = `${identity.collectionName}_ordinary`;
    const response = await agent()
      .resource('collections')
      .create({
        values: {
          name,
          title: 'Ordinary creation',
          tenancy: 'shared',
          fields: [{ name: 'name', type: 'string' }],
        },
      });
    expect(response.status).toBe(200);
    const record = await app.db.getRepository('collections').findOne({ filterByTk: name });
    expect(record.getDataValue('options')).not.toHaveProperty('tenantAccess');
    expect(app.db.getCollection(name).options).toMatchObject({ title: 'Ordinary creation', tenancy: 'shared' });
    expect(app.db.getCollection(name).options).not.toHaveProperty('tenantAccess');
  });

  it('publishes the versioned store write and preserves it during ordinary HTTP option changes', async () => {
    registerAccessConfigGuards(app.db); // Idempotent installation must not duplicate audit writes.
    const config = await store.save(identity, draft(), { userId: user.get('id') });
    expect(config.revision).toBe(1);
    expect(await revisions()).toBe(1);
    expect(collection.options.tenantAccess).toEqual(config);
    const response = await update({ title: 'Edited', options: { color: 'green' } });
    expect(response.status).toBe(200);
    expect(await store.read(identity)).toEqual(config);
    expect(await revisions()).toBe(1);
    expect(collection.options).toMatchObject({ color: 'green', tenantAccess: config, tenancy: 'shared' });
  });

  it.each(['direct', 'nested', 'direct-path', 'nested-path'] as const)(
    'rejects a root caller changing rules through the ordinary %s metadata form',
    async (kind) => {
      const config = await store.save(identity, draft(), { userId: user.get('id') });
      const proposed = { ...config, rules: [] };
      const values =
        kind === 'direct'
          ? { tenantAccess: proposed }
          : kind === 'nested'
            ? { options: { tenantAccess: proposed } }
            : kind === 'direct-path'
              ? { 'tenantAccess.revision': 99 }
              : { 'options.tenantAccess.revision': 99 };
      const response = await update({ title: 'Denied change', ...values });
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(await store.read(identity)).toEqual(config);
      expect(collection.options.tenantAccess).toEqual(config);
      expect((await metadata()).get('title')).toBe('Original');
      expect(collection.options.title).toBe('Original');
      expect(await revisions()).toBe(1);
    },
  );

  it('rejects copied configuration during ordinary HTTP collection creation', async () => {
    const name = `${identity.collectionName}_copy`;
    const response = await agent()
      .resource('collections')
      .create({
        values: {
          name,
          title: 'Copy',
          tenantAccess: draft(),
          fields: [{ name: 'name', type: 'string' }],
        },
      });
    expect(response.status).toBe(400);
    expect(await app.db.getRepository('collections').findOne({ filterByTk: name })).toBeNull();
    expect(app.db.hasCollection(name)).toBe(false);
    expect(await revisions()).toBe(0);
  });

  it('does not publish changed runtime rules when the audit insert fails', async () => {
    const config = await store.save(identity, draft(), { userId: user.get('id') });
    const fail = () => {
      throw new Error('metadata audit write failed');
    };
    app.db.on('tenantAccessRevisions.beforeCreate', fail);
    try {
      await expect(store.save(identity, { ...config, rules: [] }, { userId: user.get('id') })).rejects.toThrow(
        'metadata audit write failed',
      );
    } finally {
      app.db.off('tenantAccessRevisions.beforeCreate', fail);
    }
    expect(await store.read(identity)).toEqual(config);
    expect(collection.options.tenantAccess).toEqual(config);
    expect(await revisions()).toBe(1);
  });

  it.each(['revision', 'previousConfig'])(
    'rolls back persisted audit %s changes without publishing new runtime rules',
    async (field) => {
      const config = await store.save(identity, draft(), { userId: user.get('id') });
      const corrupted = field === 'revision' ? 99 : null;
      let observedInsert = false;
      const alterAudit = (model) => model.setDataValue(field, corrupted);
      const observeInsert = async (model, options) => {
        const row = await app.db.getCollection('tenantAccessRevisions').model.findByPk(model.get('id'), {
          transaction: options.transaction,
        });
        observedInsert = row.get(field) === corrupted;
      };
      app.db.on('tenantAccessRevisions.beforeCreate', alterAudit);
      app.db.on('tenantAccessRevisions.afterCreate', observeInsert);
      try {
        await expect(store.save(identity, { ...config, rules: [] }, { userId: user.get('id') })).rejects.toMatchObject({
          code: 'INVALID_ACCESS_CONFIG_WRITE',
        });
      } finally {
        app.db.off('tenantAccessRevisions.beforeCreate', alterAudit);
        app.db.off('tenantAccessRevisions.afterCreate', observeInsert);
      }
      expect(observedInsert).toBe(true);
      expect(await store.read(identity)).toEqual(config);
      expect(collection.options.tenantAccess).toEqual(config);
      expect(await revisions()).toBe(1);
    },
  );

  it('preserves the newest rules when a stale native CollectionModel saves unrelated options', async () => {
    const first = await store.save(identity, draft(), { userId: user.get('id') });
    const stale = await metadata();
    const second = await store.save(identity, { ...first, rules: [] }, { userId: user.get('id') });
    stale.setDataValue('options', { ...stale.getDataValue('options'), color: 'stale editor' });
    await app.db.sequelize.transaction(async (transaction) => {
      await stale.save({ transaction });
    });
    expect(await store.read(identity)).toEqual(second);
    expect(collection.options).toMatchObject({ color: 'stale editor', tenantAccess: second });
    expect(await revisions()).toBe(2);
  });

  it('rejects an otherwise valid audit revision forged through HTTP', async () => {
    const response = await agent()
      .resource('tenantAccessRevisions')
      .create({
        values: {
          ...identity,
          revision: 1,
          config: { ...draft(), revision: 1 },
          previousConfig: null,
          actorUserId: String(user.get('id')),
          savedAt: new Date().toISOString(),
        },
      });
    expect(response.status).toBe(400);
    expect(await revisions()).toBe(0);
    expect(await store.read(identity)).toBeNull();
  });
});
