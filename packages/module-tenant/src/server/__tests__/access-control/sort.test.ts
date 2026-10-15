import { ACL, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessFilterTreeService } from '../../access-control/filter-tree';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRequestFilterParser, type AccessFilterReadGrant } from '../../access-control/request-filter';
import { AccessSortService } from '../../access-control/sort';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const identities = ['documents', 'projects', 'companies'].map((collectionName) => ({
  ...mainIdentity,
  collectionKey: `${collectionName}-key`,
  collectionName,
}));

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('scoped sorting (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let sorts: AccessSortService;
  let store: AccessConfigStore;
  let grants: Map<string, AccessFilterReadGrant | null>;
  let resolver: ReturnType<typeof vi.fn>;
  let ctx: object;
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const identity of identities) {
      const collection = db.collection({
        name: identity.collectionName,
        tableName: `sort_${identity.collectionName}`,
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
          { name: 'companyId', type: 'integer', field: 'company_id' },
          { name: 'deletedAt', type: 'date' },
          { name: 'labels', type: 'json' },
        ],
      });
      await collection.model.sync();
      if (identity.collectionName !== 'documents')
        await db
          .getRepository('collections')
          .create({ values: { key: identity.collectionKey, name: collection.name } });
    }
    docs = db.getCollection('documents');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    docs.setField('scopedProject', {
      type: 'belongsTo',
      target: 'projects',
      foreignKey: 'projectId',
      scope: { name: 'Zebra' },
    });
    docs.setField('children', { type: 'hasMany', target: 'projects', foreignKey: 'companyId' });
    db.getCollection('projects').setField('company', {
      type: 'belongsTo',
      target: 'companies',
      foreignKey: 'companyId',
    });
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Owned', amount: 10, projectId: 101 },
      { id: 2, tenantId: 'H', name: 'Visible', amount: 20, projectId: 103 },
      { id: 3, tenantId: 'C', name: 'Hidden', amount: 30, projectId: 101 },
      { id: 4, tenantId: null, name: 'Legacy', amount: 40, projectId: 104 },
      { id: 5, tenantId: 'B', name: 'Empty', amount: 50 },
      { id: 6, tenantId: 'B', name: 'DisabledTarget', amount: 60, projectId: 105 },
      { id: 7, tenantId: 'B', name: 'DisabledRoot', amount: 70, enabled: false },
      { id: 8, tenantId: 'B', name: 'DeletedTarget', amount: 80, projectId: 106 },
    ]);
    await db.getCollection('projects').model.bulkCreate([
      { id: 101, tenantId: 'B', name: 'Zebra', companyId: 201 },
      { id: 103, tenantId: 'C', name: 'Hidden', companyId: 201 },
      { id: 104, tenantId: null, name: 'Legacy', companyId: 203 },
      { id: 105, tenantId: 'B', name: 'Alpha', enabled: false },
      { id: 106, tenantId: 'B', name: 'Alpha', deletedAt: new Date() },
    ]);
    await db.getCollection('companies').model.bulkCreate([
      { id: 201, tenantId: 'B', name: 'Beta' },
      { id: 203, tenantId: null, name: 'Legacy' },
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
    store = new AccessConfigStore(db, (identity) =>
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
    sorts = new AccessSortService(db, adapter, queries, resolver);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "sort_projects", "sort_companies", "sort_documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });
  const plan = (sort: unknown) => sorts.scopeRoots(ctx, mainIdentity, { tenantId: 'B' }, { sort });
  const rows = async (sort: unknown, options: { limit?: number; offset?: number } = {}) => {
    const scoped = await plan(sort);
    scoped.assertCurrent();
    const records = await docs.model.findAll({ ...scoped.query, ...options, attributes: ['id'] });
    scoped.assertCurrent();
    return records.map((row) => row.getDataValue('id'));
  };
  it('sorts root physical fields within G/V without losing root scopes', async () => {
    expect(await rows(['-amount'])).toEqual([8, 6, 5, 4, 2, 1]);
    expect(await rows([])).toEqual([1, 2, 4, 5, 6, 8]);
  });
  it('sorts only readable targets with missing and hidden targets last', async () => {
    expect(await rows(['project.name'])).toEqual([4, 1, 2, 5, 6, 8]);
    expect(await rows(['-project.name'])).toEqual([1, 4, 2, 5, 6, 8]);
    await db.getCollection('projects').model.update({ name: 'ZZZZSecret' }, { where: { id: 103 } });
    expect(await rows(['project.name'])).toEqual([4, 1, 2, 5, 6, 8]);
  });
  it('applies each nested target scope and association scope independently', async () => {
    expect(await rows(['project.company.name'])).toEqual([1, 4, 2, 5, 6, 8]);
    expect(await rows(['scopedProject.name'])).toEqual([1, 2, 4, 5, 6, 8]);
    grants.set('project.company', { identity: identities[2], fields: ['name'], where: { id: 203 } });
    expect(await rows(['project.company.name'])).toEqual([4, 1, 2, 5, 6, 8]);
  });
  it('keeps page boundaries stable and aggregate roots unduplicated', async () => {
    expect(await rows(['project.name'], { limit: 3 })).toEqual([4, 1, 2]);
    expect(await rows(['project.name'], { limit: 3, offset: 3 })).toEqual([5, 6, 8]);
    const scoped = await plan(['project.name']);
    const query = scoped.rootQuery;
    expect(await docs.model.count(query)).toBe(6);
    expect(await docs.model.sum('amount', query)).toBe(260);
    scoped.assertCurrent();
  });
  it('reuses a prepared sort concurrently without leaking predicates or bindings between plans', async () => {
    grants.set('project', {
      identity: identities[1],
      fields: ['name'],
      where: literal('"projects"."display_name" = $sortWanted'),
      bind: { sortWanted: 'Zebra' },
    });
    const prepared = sorts.prepareRoots(ctx, mainIdentity, { tenantId: 'B' }, { sort: ['project.name'] });
    const plans = await Promise.all([
      prepared.scopeRoots({
        sourceWhere: literal('"documents"."record_id" >= $boundary'),
        sourceBind: { boundary: 4 },
      }),
      prepared.scopeRoots({
        sourceWhere: literal('"documents"."record_id" <= $boundary'),
        sourceBind: { boundary: 2 },
      }),
    ]);
    for (const [index, scoped] of plans.entries()) {
      const records = await docs.model.findAll({ ...scoped.query, attributes: ['id'] });
      expect(records.map((row) => row.getDataValue('id'))).toEqual(index ? [1, 2] : [4, 5, 6, 8]);
      expect(scoped.rootQuery.bind).not.toHaveProperty('sortWanted');
      expect(await docs.model.count(scoped.rootQuery)).toBe(index ? 2 : 4);
      expect(await docs.model.sum('amount', scoped.rootQuery)).toBe(index ? 30 : 230);
      scoped.assertCurrent();
    }
  });
  it('preserves source and target ACL predicates and named values', async () => {
    grants.set('', { identity: mainIdentity, fields: ['id', 'project'], where: { id: { [Op.ne]: 2 } } });
    grants.set('project', { identity: identities[1], fields: ['name'], where: { name: { [Op.ne]: 'Legacy' } } });
    expect(await rows(['project.name'])).toEqual([1, 4, 5, 6, 8]);
    grants.set('', {
      identity: mainIdentity,
      fields: ['project'],
      where: literal('"documents"."record_id" <> $excluded'),
      bind: { excluded: 2 },
    });
    grants.set('project', {
      identity: identities[1],
      fields: ['name'],
      where: literal('"projects"."display_name" = $wanted'),
      bind: { wanted: 'Zebra' },
    });
    const scoped = await plan(['project.name']);
    expect(await rows(['project.name'])).toEqual([1, 4, 5, 6, 8]);
    expect(await docs.model.count(scoped.rootQuery)).toBe(5);
    expect(await docs.model.sum('amount', scoped.rootQuery)).toBe(240);
    expect(scoped.rootQuery.bind).not.toHaveProperty('wanted');
  });
  it('composes already scoped request filters without discarding conditions', async () => {
    const parser = new AccessRequestFilterParser(db, resolver);
    const filtered = await new AccessFilterTreeService(db, adapter, queries).scopeRoots(
      ctx,
      mainIdentity,
      { tenantId: 'B' },
      parser.parse(mainIdentity, { amount: { $gte: 20 } }),
    );
    const scoped = await sorts.scopeRoots(
      ctx,
      mainIdentity,
      { tenantId: 'B' },
      { sort: ['project.name'], sourceWhere: filtered.query.where, sourceBind: filtered.query.bind },
    );
    const result = await docs.model.findAll({ ...scoped.query, attributes: ['id'] });
    filtered.assertCurrent();
    scoped.assertCurrent();
    expect(result.map((row) => row.getDataValue('id'))).toEqual([4, 2, 5, 6, 8]);
  });
  it('does not inherit root tenancy when a target is explicitly shared', async () => {
    await store.save(
      identities[1],
      { ...configFor({ type: 'constant', value: true }), revision: 1, ownership: { enabled: false } },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, identities);
    expect(await rows(['project.name'])).toEqual([2, 4, 1, 5, 6, 8]);
  });
  it('requires source, each association field, final field and target grants', async () => {
    for (const [path, grant] of [
      ['', { identity: mainIdentity, fields: ['id'] }],
      ['project', null],
      ['project', { identity: identities[1], fields: ['name'] }],
      ['project.company', { identity: identities[2], fields: ['id'] }],
    ] as const) {
      grants.set(path, grant);
      await expect(plan(['project.company.name'])).rejects.toThrow();
      grants.clear();
    }
  });
  it('rejects unsafe sorting before resolving any grants', async () => {
    const getter = vi.fn(() => 'name');
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { get: getter });
    const sparse: unknown[] = [];
    sparse.length = 1;
    for (const sort of [
      accessor,
      sparse,
      ['name; DROP TABLE documents'],
      ['-'],
      ['project..name'],
      ['name DESC'],
      ['__proto__.name'],
      Array.from({ length: 21 }, () => 'name'),
      ['a.'.repeat(5) + 'name'],
    ]) {
      resolver.mockClear();
      await expect(plan(sort)).rejects.toThrow();
      expect(resolver).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects unsupported multi-valued, missing and JSON fields', async () => {
    for (const sort of [['children.name'], ['labels'], ['missing'], ['project.missing'], ['name', '-name']])
      await expect(plan(sort)).rejects.toThrow();
  });
  it('rejects ambiguous binding values while allowing identical bindings', async () => {
    grants.set('', { identity: mainIdentity, fields: ['project'], bind: { marker: 'root' } });
    grants.set('project', { identity: identities[1], fields: ['name'], bind: { marker: 'target' } });
    await expect(plan(['project.name'])).rejects.toThrow();
    grants.set('project', { identity: identities[1], fields: ['name'], bind: { marker: 'root' } });
    expect((await plan(['project.name'])).query.bind?.marker).toBe('root');
  });
  it('snapshots inputs and grants before asynchronous scope calculation', async () => {
    const sort = ['project.name'];
    const grant: AccessFilterReadGrant = { identity: identities[1], fields: ['name'], where: { name: 'Zebra' } };
    grants.set('project', grant);
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      sort[0] = '-amount';
      (grant.where as { name: string }).name = 'Legacy';
      return original(...args);
    });
    const scoped = await sorts.scopeRoots(ctx, mainIdentity, { tenantId: 'B' }, { sort });
    const result = await docs.model.findAll({ ...scoped.query, attributes: ['id'] });
    expect(result.map((row) => row.getDataValue('id'))).toEqual([1, 2, 4, 5, 6, 8]);
  });
  it('rejects phase and metadata changes during or after compilation', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const scoped = await original(...args);
      adapter.release(ctx);
      return scoped;
    });
    await expect(plan(['project.name'])).rejects.toThrow();
    await adapter.prepare(ctx, identities);
    const scoped = await plan(['project.name']);
    db.getCollection('projects').model.rawAttributes.name.field = 'changed';
    expect(() => scoped.assertCurrent()).toThrow();
  });
  it('keeps authorization SQL count independent of 20 or 100 returned roots', async () => {
    await docs.model.bulkCreate(
      Array.from({ length: 100 }, (_, index) => ({
        id: 1000 + index,
        tenantId: 'B',
        name: 'Load',
        amount: 1,
        projectId: 101,
      })),
    );
    const execute = async (limit: number) => {
      const log: string[] = [];
      const runtime = db.sequelize as unknown as { options: { logging: false | ((sql: string) => void) } };
      const previous = runtime.options.logging;
      runtime.options.logging = (sql: string) => log.push(sql);
      try {
        const scoped = await plan(['project.company.name', '-project.amount']);
        const records = await docs.model.findAll({ ...scoped.query, attributes: ['id'], limit });
        scoped.assertCurrent();
        expect(records).toHaveLength(limit);
        return log;
      } finally {
        runtime.options.logging = previous;
      }
    };
    const small = await execute(20);
    const large = await execute(100);
    expect(large.length).toBe(small.length);
    expect(large.length).toBeLessThanOrEqual(6);
    expect(large.at(-1)).not.toMatch(/\bJOIN\b/i);
  });
});
