import { ACL, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessReadService } from '../../access-control/reads';
import type { AccessFilterReadGrant } from '../../access-control/request-filter';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };
const identities = [mainIdentity, projectIdentity];

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('unified root reads (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let reads: AccessReadService;
  let grants: Map<string, AccessFilterReadGrant | null>;
  let resolver: ReturnType<typeof vi.fn>;
  let ctx: object;
  const auth = { tenantId: 'B' };
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const identity of identities) {
      const collection = db.collection({
        name: identity.collectionName,
        tableName: `read_${identity.collectionName}`,
        timestamps: true,
        paranoid: true,
        defaultScope: { where: { enabled: true } },
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string', field: 'display_name' },
          { name: 'amount', type: 'integer' },
          { name: 'enabled', type: 'boolean', defaultValue: true },
          { name: 'projectId', type: 'integer', field: 'project_id' },
          { name: 'deletedAt', type: 'date' },
          { name: 'labels', type: 'json' },
        ],
      });
      await collection.model.sync();
      if (identity !== mainIdentity)
        await db
          .getRepository('collections')
          .create({ values: { key: identity.collectionKey, name: collection.name } });
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Owned', amount: 10, projectId: 101 },
      { id: 2, tenantId: 'H', name: 'Visible', amount: 20, projectId: 102 },
      { id: 3, tenantId: 'C', name: 'Hidden', amount: 30, projectId: 101 },
      { id: 4, tenantId: null, name: 'Legacy', amount: 40, projectId: 103 },
      { id: 5, tenantId: 'B', name: 'Empty', amount: 50 },
      { id: 6, tenantId: 'B', name: 'Disabled', amount: 60, enabled: false },
      { id: 7, tenantId: 'B', name: 'Deleted', amount: 70, deletedAt: new Date() },
    ]);
    await projects.model.bulkCreate([
      { id: 101, tenantId: 'B', name: 'Zebra' },
      { id: 102, tenantId: 'C', name: 'Secret' },
      { id: 103, tenantId: 'B', name: 'Alpha' },
    ]);
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    const key = (collection: Collection) =>
      accessCollectionKey(identities.find((i) => i.collectionName === collection.name)!);
    const store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: key }),
    );
    const config = configFor(ownerCondition);
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
    for (const identity of identities) await store.save(identity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    ctx = {};
    await adapter.prepare(ctx, identities);
    queries = new AccessQueryService(db, adapter, key);
    grants = new Map();
    resolver = vi.fn((collection: Collection, path: readonly string[]) =>
      grants.has(path.join('.'))
        ? grants.get(path.join('.'))
        : {
            identity: identities.find((i) => i.collectionName === collection.name)!,
            fields: [...Object.keys(collection.model.rawAttributes), ...Object.keys(collection.model.associations)],
          },
    );
    reads = new AccessReadService(db, adapter, queries, resolver);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "read_documents", "read_projects", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });
  const list = (request: object = {}) => reads.list(ctx, mainIdentity, auth, { attributes: ['id'], ...request });
  const get = (key: unknown, request: object = {}) =>
    reads.get(ctx, mainIdentity, auth, { key, attributes: ['id'], ...request });
  const count = (filter: unknown = {}) => reads.count(ctx, mainIdentity, auth, { filter });
  const sum = (filter: unknown = {}) => reads.sum(ctx, mainIdentity, auth, { field: 'amount', filter });
  it('uses the same G/V and root constraints for all four operations', async () => {
    expect(await list()).toEqual([1, 2, 4, 5].map((id) => ({ id })));
    expect(await count()).toBe(4);
    expect(await sum()).toBe(120);
    expect(await get(2)).toEqual({ id: 2 });
    for (const id of [3, 6, 7, 999]) expect(await get(id)).toBeNull();
  });
  it('combines parsed association filters with ordering without changing aggregate roots', async () => {
    const filter = { project: { name: { $includes: 'a' } } };
    expect(await list({ filter, sort: ['project.name'] })).toEqual([{ id: 4 }, { id: 1 }]);
    expect(await count(filter)).toBe(2);
    expect(await sum(filter)).toBe(50);
    expect(await get(1, { filter })).toEqual({ id: 1 });
    expect(await get(2, { filter })).toBeNull();
    expect(await list({ filter: { project: { name: 'Secret' } } })).toEqual([]);
  });
  it('intersects root and target role grants and preserves named bindings', async () => {
    grants.set('', {
      identity: mainIdentity,
      fields: ['id', 'amount', 'project'],
      where: literal('"documents"."record_id" <> $excluded'),
      bind: { excluded: 5 },
    });
    grants.set('project', {
      identity: projectIdentity,
      fields: ['name'],
      where: literal('"projects"."display_name" = $wanted'),
      bind: { wanted: 'Zebra' },
    });
    const filter = { project: { name: { $includes: 'a' } } };
    expect(await list({ filter, sort: ['project.name'] })).toEqual([{ id: 1 }]);
    expect(await count(filter)).toBe(1);
    expect(await sum(filter)).toBe(10);
    expect(await list({ sort: ['project.name'] })).toEqual([{ id: 1 }, { id: 2 }, { id: 4 }]);
  });
  it('reserves sort-only grant binding names before compiling filters', async () => {
    grants.set('project', {
      identity: projectIdentity,
      fields: ['name'],
      where: literal('"projects"."display_name" = $tac_scope0_0'),
      bind: { tac_scope0_0: 'Zebra' },
    });
    expect(await list({ sort: ['project.name'] })).toEqual([1, 2, 4, 5].map((id) => ({ id })));
    expect(await count()).toBe(4);
    expect(await sum()).toBe(120);
  });
  it('returns large authorized JSON values without applying mutation input limits', async () => {
    const labels = Array.from({ length: 10000 }, (_, index) => index);
    await docs.model.update({ labels }, { where: { id: 1 } });
    expect(await list({ attributes: ['labels'], filter: { id: 1 } })).toEqual([{ labels }]);
    expect(await get(1, { attributes: ['labels'] })).toEqual({ labels });
  });
  it('projects only authorized physical values without getters or internal keys', async () => {
    const getter = vi.fn(() => 'secret getter');
    Object.defineProperty(docs.model.rawAttributes.name, 'get', { value: getter, configurable: true });
    (docs.model as typeof docs.model & { refreshAttributes(): void }).refreshAttributes();
    expect((await docs.model.findByPk(1))?.get('name')).toBe('secret getter');
    getter.mockClear();
    grants.set('', { identity: mainIdentity, fields: ['name'] });
    expect(await list({ attributes: ['name'], limit: 1 })).toEqual([{ name: 'Owned' }]);
    expect(await get(1, { attributes: ['name'] })).toEqual({ name: 'Owned' });
    expect(getter).not.toHaveBeenCalled();
    await expect(list({ attributes: ['id'] })).rejects.toThrow();
    await expect(sum()).rejects.toThrow();
  });
  it('keeps page order stable with hidden targets last in both directions', async () => {
    expect(await list({ sort: ['project.name'], limit: 2 })).toEqual([{ id: 4 }, { id: 1 }]);
    expect(await list({ sort: ['project.name'], limit: 2, offset: 2 })).toEqual([{ id: 2 }, { id: 5 }]);
    expect(await list({ sort: ['-project.name'] })).toEqual([1, 4, 2, 5].map((id) => ({ id })));
    expect(await count()).toBe(4);
  });
  it('returns zero count and null sum for an empty readable set', async () => {
    const filter = { name: 'Missing' };
    expect(await list({ filter })).toEqual([]);
    expect(await count(filter)).toBe(0);
    expect(await sum(filter)).toBeNull();
  });
  it('reads an explicitly shared model without a tenant column or tenant identity', async () => {
    const key = (collection: Collection) =>
      accessCollectionKey(identities.find((i) => i.collectionName === collection.name)!);
    const store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: key }),
    );
    await store.save(
      projectIdentity,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
      { userId: 28 },
    );
    await db.sequelize.getQueryInterface().removeColumn('read_projects', 'tenant_id');
    projects.removeField('tenantId');
    adapter.release(ctx);
    await adapter.prepare(ctx, identities);
    const query = vi.spyOn(db.sequelize, 'query');
    expect(await reads.list(ctx, projectIdentity, {}, { attributes: ['name'] })).toEqual([
      { name: 'Zebra' },
      { name: 'Secret' },
      { name: 'Alpha' },
    ]);
    expect(await reads.get(ctx, projectIdentity, {}, { key: 102, attributes: ['name'] })).toEqual({ name: 'Secret' });
    expect(await reads.count(ctx, projectIdentity, {})).toBe(3);
    expect(await reads.sum(ctx, projectIdentity, {}, { field: 'amount' })).toBeNull();
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('tenant_id');
  });
  it('rejects virtual projection and missing root grants', async () => {
    docs.setField('derived', { type: 'virtual', get: () => 'Secret' });
    await expect(list({ attributes: ['derived'] })).rejects.toThrow();
    grants.set('', null);
    await expect(list()).rejects.toThrow();
    await expect(count()).rejects.toThrow();
    await expect(sum()).rejects.toThrow();
  });
  it.each([
    { limit: 0 },
    { limit: 1001 },
    { limit: '20' },
    { offset: -1 },
    { offset: 1000001 },
    { offset: 1.1 },
    { attributes: [] },
    { attributes: ['nope'] },
    { attributes: ['project'] },
    { attributes: ['id', 'id'] },
    { attributes: ['id'], include: ['project'] },
    { raw: true },
    { where: {} },
    { bind: {} },
    { sort: ['amount DESC'] },
    { attributes: Object.assign([], { length: 1 }) },
  ])('rejects unsupported or malformed list requests: %j', async (request) => {
    await expect(list(request)).rejects.toThrow();
  });
  it('rejects nonnumeric and association sum fields and ORM options on non-list operations', async () => {
    for (const field of ['name', 'project.amount', 'labels', literal('amount')])
      await expect(reads.sum(ctx, mainIdentity, auth, { field })).rejects.toThrow();
    await expect(reads.count(ctx, mainIdentity, auth, { limit: 1 } as never)).rejects.toThrow();
    await expect(get('_')).rejects.toThrow();
  });
  it('rejects request accessors without invoking them', async () => {
    const getter = vi.fn(() => ['id']);
    // Pass the original object: spreading an accessor would invoke it before reaching the service.
    await expect(
      reads.list(ctx, mainIdentity, auth, Object.defineProperty({}, 'attributes', { get: getter }) as never),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('snapshots requests, identities and all grants before asynchronous scope resolution', async () => {
    const source = { ...mainIdentity };
    const authenticated = { tenantId: 'B' };
    const request = { attributes: ['id'], filter: { name: { $ne: 'Empty' } }, sort: ['project.name'] };
    const root: AccessFilterReadGrant = {
      identity: { ...mainIdentity },
      fields: ['id', 'name', 'project'],
      where: { id: { [Op.ne]: 2 } },
    };
    const target: AccessFilterReadGrant = {
      identity: { ...projectIdentity },
      fields: ['name'],
      where: { name: { [Op.ne]: 'Alpha' } },
    };
    grants.set('', root);
    grants.set('project', target);
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      request.attributes[0] = 'tenantId';
      request.filter.name.$ne = 'Owned';
      request.sort[0] = '-amount';
      source.collectionKey = 'wrong';
      authenticated.tenantId = 'C';
      root.fields = ['tenantId'];
      root.where = {};
      target.where = {};
      return original(...args);
    });
    expect(await reads.list(ctx, source, authenticated, request)).toEqual([{ id: 1 }, { id: 4 }]);
    expect(resolver.mock.calls.filter(([, path]) => path.length === 0)).toHaveLength(1);
    expect(resolver.mock.calls.filter(([, path]) => path.join('.') === 'project')).toHaveLength(1);
  });
  it('rejects changes to sort-only relation metadata during filter compilation', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      Object.assign(docs.model.associations.project, { scope: { name: 'Secret' } });
      return result;
    });
    await expect(list({ sort: ['project.name'] })).rejects.toThrow(/changed/);
  });
  it('rejects ended phases after the actual database read instead of returning stale results', async () => {
    const original = docs.model.findAll.bind(docs.model);
    vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      adapter.release(ctx);
      return result;
    });
    await expect(list()).rejects.toThrow();
  });
  it.each(['get', 'count', 'sum'] as const)('checks the phase after executing %s', async (kind) => {
    const query = db.sequelize.query.bind(db.sequelize);
    vi.spyOn(db.sequelize, 'query').mockImplementation(async (...args) => {
      const result = await query(...args);
      if (String(args[0]).includes('read_documents')) adapter.release(ctx);
      return result;
    });
    await expect(kind === 'get' ? get(1) : kind === 'count' ? count() : sum()).rejects.toThrow();
  });
  it('rejects foreign, finished and fake transactions before reading records', async () => {
    const foreign = sqliteDatabase();
    const foreignTransaction = await foreign.sequelize.transaction();
    const finished = await db.sequelize.transaction();
    await finished.rollback();
    const find = vi.spyOn(docs.model, 'findAll');
    try {
      for (const transaction of [{}, foreignTransaction, finished])
        await expect(list({ transaction })).rejects.toThrow(/transaction/i);
      expect(find).not.toHaveBeenCalled();
    } finally {
      await foreignTransaction.rollback();
      await foreign.close();
    }
  });
  it('passes the execution transaction and bypasses ORM query hooks', async () => {
    const hook = vi.fn(() => {
      throw new Error('unexpected ORM hook');
    });
    docs.model.addHook('beforeFind', 'read-test', hook);
    docs.model.addHook('beforeCount', 'count-test', hook);
    const transaction = await db.sequelize.transaction();
    try {
      await docs.model.create({ id: 9, tenantId: 'B', name: 'Uncommitted', amount: 90 }, { transaction });
      expect(await list({ filter: { id: 9 }, transaction })).toEqual([{ id: 9 }]);
      expect(await reads.count(ctx, mainIdentity, auth, { filter: { id: 9 }, transaction })).toBe(1);
      expect(await reads.sum(ctx, mainIdentity, auth, { field: 'amount', filter: { id: 9 }, transaction })).toBe(90);
      expect(hook).not.toHaveBeenCalled();
    } finally {
      await transaction.rollback();
    }
    expect(await get(9)).toBeNull();
  });
  it('keeps SQL query count constant for 20 and 100 root rows', async () => {
    await docs.model.bulkCreate(
      Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, tenantId: 'B', name: 'More', projectId: 101 })),
    );
    const query = vi.spyOn(db.sequelize, 'query');
    const run = async (limit: number) => {
      query.mockClear();
      expect(await list({ sort: ['project.name'], limit })).toHaveLength(limit);
      return query.mock.calls.length;
    };
    expect(await run(20)).toBe(await run(100));
    expect(await list()).toHaveLength(20);
  });
});
