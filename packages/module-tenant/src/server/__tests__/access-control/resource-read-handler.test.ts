import { ACL, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessRelatedReadAuthorizer } from '../../access-control/related-read-contexts';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { finalizedReadContext } from './finalized-read-context';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const actor = () => ({ tenantId: 'B', roleName: 'reader', userId: 28 });

describe.skipIf(!postgresUrl)('unified internal resource reads', () => {
  let db: Database;
  let docs: Collection;
  let children: Collection;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessRootReadHandler;
  let store: AccessConfigStore;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: `${collection.name}-key`,
  });

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl!);
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const name of ['documents', 'children'])
      db.collection({
        name,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'tenantId', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
        ],
      });
    docs = db.getCollection('documents');
    children = db.getCollection('children');
    docs.setField('children', { type: 'hasMany', target: 'children', foreignKey: 'documentId' });
    docs.setField('child', { type: 'hasOne', target: 'children', foreignKey: 'documentId' });
    docs.setField('primary', { type: 'belongsTo', target: 'children', foreignKey: 'primaryId' });
    children.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    db.collection({ name: 'links', timestamps: false });
    docs.setField('selections', {
      type: 'belongsToMany',
      target: 'children',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'childId',
    });
    db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.sync();
    await db.getCollection('tenants').model.bulkCreate([
      { id: 'H', enabled: true },
      { id: 'B', parentId: 'H', enabled: true },
      { id: 'C', parentId: 'H', enabled: true },
    ]);
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Owned', amount: 100 },
      { id: 2, tenantId: 'H', name: 'Visible', amount: 200 },
      { id: 3, tenantId: 'C', name: 'Hidden', amount: 300 },
      { id: 4, tenantId: 'B', name: 'Single', amount: 400 },
      { id: 5, tenantId: null, name: 'Legacy', amount: 500 },
    ]);
    await children.model.bulkCreate([
      { id: 101, documentId: 1, tenantId: 'B', name: 'Owned' },
      { id: 102, documentId: 1, tenantId: 'H', name: 'Visible' },
      { id: 103, documentId: 1, tenantId: 'C', name: 'Hidden' },
      { id: 104, documentId: 2, tenantId: 'B', name: 'Owned' },
      { id: 105, documentId: 3, tenantId: 'B', name: 'Owned' },
      { id: 106, documentId: 4, tenantId: 'B', name: 'Owned' },
    ]);
    await docs.model.update({ primaryId: 101 }, { where: { id: 1 } });
    await db.getCollection('links').model.bulkCreate([101, 102, 103].map((childId) => ({ documentId: 1, childId })));
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    for (const name of ['documents', 'children', 'links']) {
      if (name !== 'documents') await db.getRepository('collections').create({ values: { key: `${name}-key`, name } });
      const config =
        name === 'links'
          ? { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false } }
          : configFor(ownerCondition);
      if (name !== 'links')
        config.rules.push({
          ...configFor(
            {
              type: 'compare',
              operator: 'in',
              left: { type: 'field', path: 'name' },
              right: { type: 'literal', value: ['Visible', 'Legacy'] },
            },
            'visibility',
          ).rules[0],
          id: 'visible',
        });
      await store.save(identity(db.getCollection(name)), { ...config, revision: 0 }, { userId: 28 });
    }
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    handler = new AccessRootReadHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await db.sequelize.drop({ cascade: true });
    } finally {
      await db.close();
    }
  });

  async function context(
    resource: string,
    action: string,
    params: Record<string, unknown> = {},
    grant = {},
    source?: number | string,
  ) {
    const ctx = await finalizedReadContext(db, resource, action, params, grant, source);
    await adapter.prepare(
      ctx,
      ['documents', 'children', 'links'].map((name) => identity(db.getCollection(name))),
    );
    return ctx;
  }
  const neutral = (collection: Collection, grant = {}) => finalizedReadContext(db, collection.name, 'list', {}, grant);
  const authorize: AccessRelatedReadAuthorizer = (collection) => neutral(collection);
  const run = (ctx: Awaited<ReturnType<typeof context>>, resolve = authorize) =>
    handler.handleResourceWithRelatedContexts(ctx, actor(), resolve);

  it.each(['list', 'get', 'count'])('routes a root %s through its actual final decision', async (kind) => {
    const ctx = await context(
      'documents',
      kind,
      kind === 'count' ? {} : { fields: ['id'], ...(kind === 'get' ? { filterByTk: 2 } : { sort: 'id' }) },
    );
    const resolve = vi.fn(async () => null);
    await run(ctx, resolve);
    expect(ctx.body).toEqual(
      kind === 'count'
        ? 4
        : kind === 'get'
          ? { id: 2 }
          : { rows: [1, 2, 4, 5].map((id) => ({ id })), count: 4, page: 1, pageSize: 20, totalPage: 1 },
    );
    expect(ctx.paginate).toBe(kind === 'list');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('sums the same G/V root set as listing without replacing its actual permission', async () => {
    const ctx = await context('documents', 'sum', { field: 'amount' });
    const resolve = vi.fn(async () => null);
    await run(ctx, resolve);
    expect(ctx.body).toBe(1200);
    expect(ctx.paginate).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('intersects sum action role conditions and the original request filter', async () => {
    const ctx = await context(
      'documents',
      'sum',
      { field: 'amount', filter: { id: { $in: [1, 2, 3] } } },
      { fields: ['amount', 'id'], filter: { id: { $ne: 1 } } },
    );
    await run(ctx);
    expect(ctx.body).toBe(200);
  });

  it.each(['children', 'selections'])('sums each root once when filtering by readable %s', async (relation) => {
    const ctx = await context('documents', 'sum', {
      field: 'amount',
      filter: { [relation]: { name: { $in: ['Owned', 'Visible'] } } },
    });
    const resolve = vi.fn(authorize);
    await run(ctx, resolve);
    expect(ctx.body).toBe(relation === 'children' ? 700 : 100);
    expect(resolve.mock.calls.map(([, path]) => path)).toEqual(
      relation === 'selections' ? [['selections'], ['selections', '$through']] : [['children']],
    );
    expect(resolve.mock.calls.every(([, , operation]) => operation.kind === 'sum')).toBe(true);
  });

  it('cannot use a hidden target to match sum filters', async () => {
    const ctx = await context('documents', 'sum', { field: 'amount', filter: { children: { name: 'Hidden' } } });
    await run(ctx);
    expect(ctx.body).toBeNull();
  });

  it('retains independently finalized target role conditions for sum filters', async () => {
    const ctx = await context('documents', 'sum', { field: 'amount', filter: { children: { name: 'Visible' } } });
    await run(ctx, (collection) => neutral(collection, { fields: ['name'], filter: { name: 'Owned' } }));
    expect(ctx.body).toBeNull();
  });

  it('captures the sum field and filter before asynchronous target authorization', async () => {
    const ctx = await context('documents', 'sum', { field: 'amount', filter: { children: { name: 'Visible' } } });
    await run(ctx, async (collection) => {
      await Promise.resolve();
      Object.assign((ctx.permission as { rawParams: object }).rawParams, { field: 'id', filter: {} });
      return neutral(collection);
    });
    expect(ctx.body).toBe(100);
  });

  it.each(['amount field denied', 'wrong action', 'target decision missing'])('rejects sum with %s', async (mode) => {
    const ctx = await context(
      'documents',
      'sum',
      { field: 'amount', ...(mode === 'target decision missing' ? { filter: { children: { name: 'Owned' } } } : {}) },
      mode === 'amount field denied' ? { fields: ['id'] } : {},
    );
    if (mode === 'wrong action') Object.assign(ctx.permission!, { actionName: 'list' });
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(run(ctx, async () => null)).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
  });

  it.each([{ appends: ['children'] }, { pageSize: 20 }, { filterByTk: 1 }])(
    'rejects non-summary sum parameters %j',
    async (extra) => {
      const ctx = await context('documents', 'sum', { field: 'amount', ...extra });
      const resolve = vi.fn(authorize);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(run(ctx, resolve)).rejects.toThrow();
      expect(resolve).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
    },
  );

  it.each([1, '_'])('does not turn association sum source %s into a direct root sum', async (source) => {
    const ctx = await context('documents.children', 'sum', { field: 'amount' }, {}, source);
    const resolve = vi.fn(authorize);
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(run(ctx, resolve)).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
  });

  it('keeps the caller transaction for finalized sum execution', async () => {
    const ctx = await context('documents', 'sum', { field: 'amount' });
    await db.sequelize.transaction(async (transaction) => {
      await docs.model.update({ amount: 900 }, { where: { id: 1 }, transaction });
      const sum = vi.spyOn(docs.model, 'sum');
      await handler.handleResourceWithRelatedContexts(ctx, actor(), authorize, transaction);
      expect(sum).toHaveBeenCalledWith('amount', expect.objectContaining({ transaction }));
      expect(ctx.body).toBe(2000);
    });
  });

  it('prepares root expansion permissions without asking for a substitute root decision', async () => {
    const ctx = await context('documents', 'get', { filterByTk: 1, fields: ['id', 'primary.name'] });
    const resolve = vi.fn(authorize);
    await run(ctx, resolve);
    expect(ctx.body).toEqual({ id: 1, primary: { name: 'Owned' } });
    expect(resolve.mock.calls.map(([, path]) => path)).toEqual([['primary']]);
  });

  it.each(['list', 'get'])('routes /_/ %s directly to targets without source membership', async (kind) => {
    const ctx = await context(
      'documents.children',
      kind,
      kind === 'get' ? { filterByTk: 105, fields: ['id'] } : { fields: ['id'], sort: 'id' },
      {},
      '_',
    );
    const resolve = vi.fn(async () => null);
    await run(ctx, resolve);
    expect(ctx.body).toEqual(
      kind === 'get'
        ? { id: 105 }
        : { rows: [101, 102, 104, 105, 106].map((id) => ({ id })), count: 5, page: 1, pageSize: 20, totalPage: 1 },
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['children', 'list', 1, { fields: ['id'], sort: 'id' }, { rows: [{ id: 101 }, { id: 102 }], count: 2 }],
    ['children', 'count', 1, {}, 2],
    ['children', 'get', 1, { fields: ['id'], filterByTk: 102 }, { id: 102 }],
    ['child', 'get', 4, { fields: ['id'] }, { id: 106 }],
    ['primary', 'get', 1, { fields: ['name'] }, { name: 'Owned' }],
    ['selections', 'list', 1, { fields: ['id'], sort: 'id' }, { rows: [{ id: 101 }, { id: 102 }], count: 2 }],
    ['selections', 'count', 1, {}, 2],
    ['selections', 'get', 1, { fields: ['id'], filterByTk: 102 }, { id: 102 }],
  ] as const)(
    'routes concrete %s %s with an independent source decision',
    async (relation, kind, sourceId, params, expected) => {
      const ctx = await context(`documents.${relation}`, kind, params, {}, sourceId);
      const resolve = vi.fn(authorize);
      await run(ctx, resolve);
      if (typeof expected === 'number') expect(ctx.body).toBe(expected);
      else expect(ctx.body).toMatchObject(expected);
      expect(ctx.paginate).toBe(kind === 'list');
      expect(resolve.mock.calls.map(([, path]) => path)).toEqual(
        relation === 'selections' ? [[], ['selections', '$through']] : [[]],
      );
      expect(resolve).toHaveBeenCalledWith(docs, [], {
        kind,
        context: ctx,
        source: mainIdentity,
        authenticated: actor(),
      });
    },
  );

  it('retains a visibility-only source while hiding unreadable targets and unrelated membership', async () => {
    const ctx = await context('documents.children', 'get', { filterByTk: 104, fields: ['id'] }, {}, 2);
    await run(ctx);
    expect(ctx.body).toEqual({ id: 104 });
    for (const id of [103, 104]) {
      const unrelated = await context('documents.children', 'get', { filterByTk: id, fields: ['id'] }, {}, 1);
      await run(unrelated);
      expect(unrelated.body).toBeNull();
    }
  });

  it.each([
    'missing',
    'denied',
    'filtered',
    'wrong action',
    'wrong collection',
    'wrong role',
    'missing relation field',
  ])('rejects a %s source decision before business SQL', async (mode) => {
    const source =
      mode === 'missing'
        ? null
        : await neutral(
            mode === 'wrong collection' ? children : docs,
            mode === 'missing relation field' ? { fields: ['id'] } : {},
          );
    if (mode === 'denied') Object.assign(source!.permission!, { can: false });
    if (mode === 'filtered')
      Object.assign((source!.permission as { rawParams: object }).rawParams, { filter: { id: 1 } });
    if (mode === 'wrong action') Object.assign(source!.action, { actionName: 'get' });
    if (mode === 'wrong role')
      Object.assign(source!.permission!, { can: { role: 'other', action: 'list', resource: 'documents' } });
    const ctx = await context('documents.children', 'list', { fields: ['id'] }, {}, 1);
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(run(ctx, async () => source)).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
    expect(ctx.paginate).toBe(false);
  });

  it.each([3, 999])('denies a hidden or missing source %i despite target read access', async (source) => {
    const ctx = await context('documents.children', 'list', { fields: ['id'] }, {}, source);
    await expect(run(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(ctx.body).toBe('unchanged');
  });

  it('intersects source role conditions with source G/V', async () => {
    const source = await neutral(docs, { filter: { id: 2 } });
    const ctx = await context('documents.children', 'list', { fields: ['id'] }, {}, 1);
    await expect(run(ctx, async () => source)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(ctx.body).toBe('unchanged');
  });

  it('keeps the target action role filter and selected fields', async () => {
    const ctx = await context(
      'documents.children',
      'list',
      { fields: ['name'] },
      { fields: ['name'], filter: { id: 102 } },
      1,
    );
    await run(ctx);
    expect(ctx.body).toMatchObject({ rows: [{ name: 'Visible' }], count: 1 });
  });

  it('captures target input and actor before awaiting the source authorizer', async () => {
    const source = await neutral(docs);
    const ctx = await context('documents.children', 'get', { filterByTk: 101, fields: ['id'] }, {}, 1);
    const authenticated = actor();
    await handler.handleResourceWithRelatedContexts(ctx, authenticated, async (_collection, path, operation) => {
      await Promise.resolve();
      expect(Object.isFrozen(path)).toBe(true);
      expect(Object.isFrozen(operation)).toBe(true);
      expect(Object.isFrozen(operation.authenticated)).toBe(true);
      authenticated.tenantId = 'C';
      Object.assign(ctx.action, { sourceId: '3', resourceOf: '3' });
      Object.assign((ctx.permission as { rawParams: object }).rawParams, { filterByTk: 103 });
      Object.assign(ctx.permission!, { can: false });
      return source;
    });
    expect(ctx.body).toEqual({ id: 101 });
  });

  it('prepares nested permissions relative to the original source after source authorization', async () => {
    const ctx = await context('documents.children', 'get', { filterByTk: 101, fields: ['id', 'document.name'] }, {}, 1);
    const resolve = vi.fn(authorize);
    await run(ctx, resolve);
    expect(ctx.body).toEqual({ id: 101, document: { name: 'Owned' } });
    expect(resolve.mock.calls.map(([, path]) => path)).toEqual([[], ['children', 'document']]);
  });

  it.each(['phase', 'relation', 'target identity'])(
    'rejects %s changes during source authorization before SQL',
    async (mode) => {
      const source = await neutral(docs);
      const ctx = await context('documents.children', 'list', { fields: ['id'] }, {}, 1);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(
        run(ctx, async () => {
          await Promise.resolve();
          if (mode === 'phase') adapter.release(ctx);
          if (mode === 'relation') docs.model.associations.children = { ...docs.model.associations.children } as never;
          if (mode === 'target identity') db.collections.delete('children');
          return source;
        }),
      ).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
    },
  );

  it('retains the caller transaction through source authorization', async () => {
    const ctx = await context('documents.children', 'get', { filterByTk: 107, fields: ['id'] }, {}, 1);
    const transaction = await db.sequelize.transaction();
    try {
      await children.model.create({ id: 107, documentId: 1, tenantId: 'B', name: 'Owned' }, { transaction });
      await handler.handleResourceWithRelatedContexts(ctx, actor(), authorize, transaction);
      expect(ctx.body).toEqual({ id: 107 });
    } finally {
      await transaction.rollback();
    }
    expect(await children.model.findByPk(107)).toBeNull();
  });

  it.each(['association scope', 'through scope', 'target model scope'])(
    'rejects in-place %s changes during source authorization before SQL',
    async (mode) => {
      const source = await neutral(docs);
      const relation = mode === 'through scope' ? 'selections' : 'children';
      const association = docs.model.associations[relation] as unknown as {
        scope?: unknown;
        through?: { scope?: unknown };
      };
      const targetModel = children.model as unknown as { _scope: unknown };
      if (mode === 'association scope') association.scope = { name: 'Visible' };
      if (mode === 'through scope') association.through!.scope = { childId: 102 };
      if (mode === 'target model scope') targetModel._scope = { where: { name: 'Visible' } };
      const ctx = await context(`documents.${relation}`, 'list', { fields: ['id'] }, {}, 1);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(
        run(ctx, async (collection, path) => {
          if (path.length) return neutral(collection);
          await Promise.resolve();
          if (mode === 'association scope') delete association.scope;
          if (mode === 'through scope') delete association.through!.scope;
          if (mode === 'target model scope') targetModel._scope = {};
          return source;
        }),
      ).rejects.toThrow(/metadata changed/);
      expect(sql).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
    },
  );

  it.each(['request expansion', 'target role filter', 'target access rule', 'through access rule'])(
    'captures %s relationship metadata before awaiting source authorization',
    async (mode) => {
      const through = mode === 'through access rule';
      const collection = through ? db.getCollection('links') : children;
      if (through) collection.setField('child', { type: 'belongsTo', target: 'children', foreignKey: 'childId' });
      const relationName = through ? 'child' : 'document';
      const relation = collection.model.associations[relationName] as unknown as { scope?: unknown };
      relation.scope = { name: 'Visible' };
      if (mode.endsWith('access rule')) {
        const config = (await store.read(identity(collection)))!;
        await store.save(
          identity(collection),
          {
            ...config,
            rules: [
              ...config.rules,
              {
                id: 'related-visibility',
                name: 'Related visibility',
                enabled: true,
                category: 'visibility',
                subject: { type: 'constant', value: true },
                condition: { type: 'exists', path: relationName, condition: { type: 'constant', value: true } },
              },
            ],
          },
          { userId: 28 },
        );
      }
      const ctx = await context(
        `documents.${through ? 'selections' : 'children'}`,
        'list',
        { fields: mode === 'request expansion' ? ['id', 'document.name'] : ['id'] },
        mode === 'target role filter' ? { filter: { document: { name: 'Owned' } } } : {},
        1,
      );
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(
        run(ctx, async (target, path) => {
          if (path.length) return neutral(target);
          await Promise.resolve();
          delete relation.scope;
          return neutral(docs);
        }),
      ).rejects.toThrow(/metadata changed/);
      expect(sql).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
    },
  );

  it.each(['list', 'get', 'count', 'sum', 'placeholder', 'chart'])(
    'captures relationship scope before awaiting target authorization for %s',
    async (entry) => {
      const placeholder = entry === 'placeholder';
      const root = placeholder ? children : docs;
      const relationName = placeholder ? 'document' : 'children';
      const relation = root.model.associations[relationName] as unknown as { scope?: unknown };
      relation.scope = { name: 'Visible' };
      const filter = { [relationName]: { name: 'Visible' } };
      const ctx = await context(
        placeholder ? 'documents.children' : 'documents',
        ['placeholder', 'chart'].includes(entry) ? 'list' : entry,
        entry === 'chart'
          ? {}
          : { filter, ...(entry === 'get' ? { filterByTk: 1 } : entry === 'sum' ? { field: 'amount' } : {}) },
        {},
        placeholder ? '_' : undefined,
      );
      const sql = vi.spyOn(db.sequelize, 'query');
      const resolve: AccessRelatedReadAuthorizer = async (collection) => {
        await Promise.resolve();
        delete relation.scope;
        return neutral(collection);
      };
      const result =
        entry === 'chart'
          ? handler.handleChartWithRelatedContexts(
              ctx,
              actor(),
              {
                collection: 'documents',
                dataSource: 'main',
                measures: [{ field: ['amount'], aggregation: 'sum', alias: 'total' }],
                dimensions: [],
                filter,
              },
              resolve,
            )
          : run(ctx, resolve);
      await expect(result).rejects.toThrow(/metadata changed/);
      expect(sql).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
    },
  );

  it.each(['root role filter', 'root access rule', 'target access rule', 'through access rule'])(
    'captures %s metadata before awaiting root related authorization',
    async (mode) => {
      const through = mode === 'through access rule';
      const collection = through ? db.getCollection('links') : mode === 'target access rule' ? children : docs;
      if (through) collection.setField('child', { type: 'belongsTo', target: 'children', foreignKey: 'childId' });
      const relationName = through ? 'child' : collection === children ? 'document' : 'primary';
      const relation = collection.model.associations[relationName] as unknown as { scope?: unknown };
      relation.scope = { name: 'Visible' };
      if (mode.endsWith('access rule')) {
        const config = (await store.read(identity(collection)))!;
        await store.save(
          identity(collection),
          {
            ...config,
            rules: [
              ...config.rules,
              {
                id: 'related-visibility',
                name: 'Related visibility',
                enabled: true,
                category: 'visibility',
                subject: { type: 'constant', value: true },
                condition: { type: 'exists', path: relationName, condition: { type: 'constant', value: true } },
              },
            ],
          },
          { userId: 28 },
        );
      }
      const ctx = await context(
        'documents',
        'list',
        { fields: ['id'], filter: { [through ? 'selections' : 'children']: { name: 'Visible' } } },
        mode === 'root role filter' ? { filter: { primary: { name: 'Visible' } } } : {},
      );
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(
        run(ctx, async (target) => {
          await Promise.resolve();
          delete relation.scope;
          return neutral(target);
        }),
      ).rejects.toThrow(/metadata changed/);
      expect(sql).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
    },
  );

  it('captures participating model scopes before awaiting root related authorization', async () => {
    const model = children.model as unknown as { _scope: unknown };
    model._scope = { where: { name: 'Visible' } };
    const ctx = await context('documents', 'list', { filter: { children: { name: 'Visible' } } });
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(
      run(ctx, async (collection) => {
        await Promise.resolve();
        model._scope = {};
        return neutral(collection);
      }),
    ).rejects.toThrow(/metadata changed/);
    expect(sql).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
  });

  it('captures many-to-many through scopes before awaiting root related authorization', async () => {
    const relation = docs.model.associations.selections as unknown as { through: { scope?: unknown } };
    relation.through.scope = { childId: 102 };
    const ctx = await context('documents', 'sum', { field: 'amount', filter: { selections: { name: 'Visible' } } });
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(
      run(ctx, async (collection) => {
        await Promise.resolve();
        delete relation.through.scope;
        return neutral(collection);
      }),
    ).rejects.toThrow(/metadata changed/);
    expect(sql).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
  });

  it('does not bind unrelated models while preparing root related authorization', async () => {
    const ctx = await context('documents', 'sum', { field: 'amount', filter: { children: { name: 'Visible' } } });
    await run(ctx, async (collection) => {
      await Promise.resolve();
      (db.getCollection('links').model as unknown as { _scope: unknown })._scope = { where: { childId: 103 } };
      return neutral(collection);
    });
    expect(ctx.body).toBe(100);
  });

  it('checks captured relation metadata after execution before publishing', async () => {
    const ctx = await context('documents.children', 'list', { fields: ['id'] }, {}, 1);
    vi.spyOn(AccessEntryReadService.prototype, 'fromResource').mockImplementationOnce(async () => {
      docs.model.associations.children = { ...docs.model.associations.children } as never;
      return [];
    });
    await expect(run(ctx)).rejects.toThrow(/association changed/);
    expect(ctx.body).toBe('unchanged');
  });

  it.each(['denied target', 'conflicting source', 'placeholder count', 'unsupported action', 'source accessor'])(
    'rejects %s without invoking authorization or SQL',
    async (mode) => {
      const ctx = await context('documents.children', 'list', { fields: ['id'] }, {}, 1);
      const getter = vi.fn(() => '1');
      if (mode === 'denied target') Object.assign(ctx.permission!, { can: false });
      if (mode === 'conflicting source') Object.assign(ctx.action, { resourceOf: '2' });
      if (mode === 'placeholder count')
        Object.assign(ctx.action, { sourceId: '_', resourceOf: '_', actionName: 'count' });
      if (mode === 'unsupported action') Object.assign(ctx.action, { actionName: 'sum' });
      if (mode === 'source accessor') Object.defineProperty(ctx.action, 'sourceId', { get: getter });
      const resolve = vi.fn(authorize);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(run(ctx, resolve)).rejects.toThrow();
      expect(resolve).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
    },
  );
});
