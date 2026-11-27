import { ACL, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import {
  accessCollectionKey,
  AccessConfigStore,
  type AccessCollectionIdentity,
} from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import type { AccessConfig } from '../../access-control/types';
import { seedConfigStore } from './config-database';
import { sqliteDatabase } from './database';
import { finalizedReadContext } from './finalized-read-context';
import { configFor, ownerCondition } from './fixtures';

const actor = { tenantId: 'B', userId: 28, roleName: 'reader' };
const relations = ['primary', 'child', 'children', 'selections'] as const;
const multiple = (relation: (typeof relations)[number]) => ['children', 'selections'].includes(relation);
const identity = (collection: Collection, dataSourceKey = 'external'): AccessCollectionIdentity => ({
  dataSourceKey,
  collectionName: collection.name,
  collectionKey: `${dataSourceKey === 'main' ? '' : `${dataSourceKey}-`}${collection.name}-key`,
});
const shared = (visibleOnly = false): AccessConfig => ({
  ...configFor(
    visibleOnly
      ? {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'External visible' },
        }
      : { type: 'constant', value: true },
  ),
  ownership: { enabled: false },
});

describe('external association read boundaries', () => {
  let primary: Database;
  let external: Database;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessRootReadHandler;

  beforeEach(async () => {
    primary = sqliteDatabase();
    external = sqliteDatabase();
    await seedConfigStore(primary);
    for (const db of [primary, external]) {
      for (const name of ['documents', 'targets'])
        db.collection({
          name,
          timestamps: false,
          fields: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'name', type: 'string' },
            { name: 'tenantId', type: 'string' },
          ],
        });
      db.collection({ name: 'links', timestamps: false, fields: [{ name: 'tenantId', type: 'string' }] });
      db.collection({
        name: 'tenants',
        timestamps: false,
        autoGenId: false,
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'enabled', type: 'boolean' },
        ],
      });
      const docs = db.getCollection('documents');
      docs.setField('primary', { type: 'belongsTo', target: 'targets', foreignKey: 'primaryId' });
      docs.setField('child', { type: 'hasOne', target: 'targets', foreignKey: 'documentId' });
      docs.setField('children', { type: 'hasMany', target: 'targets', foreignKey: 'documentId' });
      docs.setField('selections', {
        type: 'belongsToMany',
        target: 'targets',
        through: 'links',
        foreignKey: 'documentId',
        otherKey: 'targetId',
      });
      await db.sync();
      // An external namesake must not provide the tenant facts rejected by the primary.
      await db.getCollection('tenants').model.create({ id: 'B', enabled: db === external });
      await docs.model.create({ id: 1, name: 'Source', primaryId: 11, tenantId: 'B' });
      await db.getCollection('targets').model.bulkCreate([
        { id: 11, documentId: 1, name: db === external ? 'External visible' : 'Main visible', tenantId: 'B' },
        { id: 12, documentId: 1, name: db === external ? 'External hidden' : 'Main hidden', tenantId: 'C' },
        { id: 13, documentId: null, name: 'External visible', tenantId: 'B' },
      ]);
      await db.getCollection('links').model.bulkCreate([
        { id: 21, documentId: 1, targetId: 11, tenantId: 'B' },
        { id: 22, documentId: 1, targetId: 12, tenantId: 'C' },
      ]);
    }
    store = new AccessConfigStore(primary, (value) => {
      const db = value.dataSourceKey === 'main' ? primary : external;
      return resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection, value.dataSourceKey)),
      });
    });
    for (const dataSourceKey of ['main', 'external'])
      for (const name of ['documents', 'targets', 'links']) {
        const db = dataSourceKey === 'main' ? primary : external;
        const value = identity(db.getCollection(name), dataSourceKey);
        // seedConfigStore already created both documents metadata rows.
        if (name !== 'documents')
          await primary.getRepository(dataSourceKey === 'main' ? 'collections' : 'dataSourcesCollections').create({
            values: { key: value.collectionKey, name, ...(dataSourceKey === 'main' ? {} : { dataSourceKey }) },
          });
        await store.save(
          value,
          { ...shared(dataSourceKey === 'external' && name === 'targets'), revision: 0 },
          {
            userId: 28,
          },
        );
      }
    adapter = new AccessAclScopeAdapter(new ACL(), 'external', store, external);
    handler = new AccessRootReadHandler(
      external,
      adapter,
      new AccessQueryService(external, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
  });

  afterEach(async () => {
    await Promise.all([primary?.close(), external?.close()]);
  });

  async function configure(name: string, config: AccessConfig) {
    const value = identity(external.getCollection(name));
    const previous = (await store.read(value))!;
    await store.save(value, { ...config, revision: previous.revision }, { userId: 28 });
  }

  async function context(resource = 'documents', params: Record<string, unknown> = {}, source?: number | string) {
    const ctx = await finalizedReadContext(external, resource, 'get', params, {}, source);
    await adapter.prepare(
      ctx,
      ['documents', 'targets', 'links'].map((name) => identity(external.getCollection(name))),
    );
    return ctx;
  }

  async function run(ctx: Awaited<ReturnType<typeof context>>, targetGrant: object = {}) {
    try {
      await handler.handleResourceWithRelatedContexts(ctx, actor, async (collection) =>
        finalizedReadContext(external, collection.name, 'list', {}, collection.name === 'targets' ? targetGrant : {}),
      );
    } finally {
      adapter.release(ctx);
    }
    return ctx.body;
  }

  it.each(relations)(
    'expands %s using external target rules instead of the main same-named table',
    async (relation) => {
      const ctx = await context('documents', {
        filterByTk: 1,
        fields: ['id', `${relation}.id`, `${relation}.name`],
      });
      const visible = { id: 11, name: 'External visible' };
      expect(await run(ctx)).toEqual({ id: 1, [relation]: multiple(relation) ? [visible] : visible });
    },
  );

  it.each(relations)('keeps a finalized target role condition on %s expansion', async (relation) => {
    const ctx = await context('documents', { filterByTk: 1, fields: ['id', `${relation}.id`] });
    expect(await run(ctx, { fields: ['id'], filter: { id: 12 } })).toEqual({
      id: 1,
      [relation]: multiple(relation) ? [] : null,
    });
  });

  it.each(relations)(
    'reads concrete %s membership using the independent external source and target',
    async (relation) => {
      const ctx = await context(`documents.${relation}`, { fields: ['id', 'name'], filterByTk: 11 }, 1);
      expect(await run(ctx)).toEqual({ id: 11, name: 'External visible' });
    },
  );

  it.each(relations)('keeps /_/ %s target filtering without requiring a readable source', async (relation) => {
    await configure('documents', { ...shared(), rules: [] });
    const visible = await context(`documents.${relation}`, { filterByTk: 13, fields: ['id', 'name'] }, '_');
    expect(await run(visible)).toEqual({ id: 13, name: 'External visible' });
    const hidden = await context(`documents.${relation}`, { filterByTk: 12, fields: ['id'] }, '_');
    expect(await run(hidden)).toBeNull();
  });

  it.each(relations)('does not match a root using a hidden %s target', async (relation) => {
    const visible = await context('documents', {
      filterByTk: 1,
      fields: ['id'],
      filter: { [relation]: { name: 'External visible' } },
    });
    expect(await run(visible)).toEqual({ id: 1 });
    if (relation === 'primary')
      await external.getCollection('documents').model.update({ primaryId: 12 }, { where: { id: 1 } });
    const ctx = await context('documents', {
      filterByTk: 1,
      fields: ['id'],
      filter: { [relation]: { name: 'External hidden' } },
    });
    expect(await run(ctx)).toBeNull();
  });

  it.each(['children', 'selections'] as const)(
    'does not return a hidden or unrelated external %s member',
    async (relation) => {
      for (const id of [12, 13]) {
        const ctx = await context(`documents.${relation}`, { filterByTk: id, fields: ['id'] }, 1);
        expect(await run(ctx)).toBeNull();
      }
    },
  );

  it.each(relations)('rejects tenant-aware %s targets before publishing an expanded result', async (relation) => {
    await configure('targets', configFor(ownerCondition));
    const ctx = await context('documents', { filterByTk: 1, fields: ['id', `${relation}.id`] });
    await expect(run(ctx)).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    expect(ctx.body).toBe('unchanged');
  });

  it.each(['expansion', 'concrete'] as const)(
    'rejects a tenant-aware external connection table during %s',
    async (mode) => {
      await configure('links', configFor({ type: 'constant', value: true }));
      const ctx =
        mode === 'expansion'
          ? await context('documents', { filterByTk: 1, fields: ['id', 'selections.id'] })
          : await context('documents.selections', { filterByTk: 11, fields: ['id'] }, 1);
      await expect(run(ctx)).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
      expect(ctx.body).toBe('unchanged');
    },
  );
});
