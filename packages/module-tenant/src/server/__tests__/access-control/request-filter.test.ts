import { ACL, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessFilterTreeService } from '../../access-control/filter-tree';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRequestFilterParser, type AccessFilterReadGrant } from '../../access-control/request-filter';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const identities = ['documents', 'projects', 'links', 'companies'].map((collectionName) => ({
  ...mainIdentity,
  collectionKey: `${collectionName}-key`,
  collectionName,
}));

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('request filtering (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let trees: AccessFilterTreeService;
  let parser: AccessRequestFilterParser;
  let grants: Map<string, AccessFilterReadGrant | null>;
  let resolveGrant: ReturnType<typeof vi.fn>;
  let ctx: object;
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const identity of identities) {
      const collection = db.collection({
        name: identity.collectionName,
        tableName: `request_filter_${identity.collectionName}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string', field: 'display_name' },
          { name: 'amount', type: 'integer' },
          { name: 'enabled', type: 'boolean' },
          { name: 'projectId', type: 'integer', field: 'project_id' },
          { name: 'documentId', type: 'integer', field: 'document_id' },
          { name: 'companyId', type: 'integer', field: 'company_id' },
          { name: 'labels', type: 'json' },
        ],
      });
      await collection.model.sync();
      if (identity.collectionName !== 'documents')
        await db
          .getRepository('collections')
          .create({ values: { key: identity.collectionKey, name: identity.collectionName } });
    }
    docs = db.getCollection('documents');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    docs.setField('children', { type: 'hasMany', target: 'projects', foreignKey: 'documentId' });
    docs.setField('single', { type: 'hasOne', target: 'projects', foreignKey: 'documentId' });
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
    });
    db.getCollection('projects').setField('company', {
      type: 'belongsTo',
      target: 'companies',
      foreignKey: 'companyId',
    });
    db.getCollection('companies').setField('projects', {
      type: 'hasMany',
      target: 'projects',
      foreignKey: 'companyId',
    });
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Owned', amount: 10, projectId: 101, enabled: true },
      { id: 2, tenantId: 'H', name: 'Visible', amount: 20, projectId: 103, enabled: false },
      { id: 3, tenantId: 'C', name: 'Hidden', amount: 30, projectId: 105 },
      { id: 4, tenantId: null, name: 'Legacy', amount: 40, projectId: 104 },
      { id: 5, tenantId: 'B', name: 'Empty', amount: 50 },
    ]);
    await db.getCollection('projects').model.bulkCreate([
      { id: 101, tenantId: 'B', name: 'Owned', documentId: 1, companyId: 201, enabled: true },
      { id: 102, tenantId: 'H', name: 'Visible', documentId: 1, companyId: 202, enabled: false },
      { id: 103, tenantId: 'C', name: 'Hidden', documentId: 2, companyId: 201 },
      { id: 104, tenantId: null, name: 'Legacy', documentId: 4, companyId: 203 },
      { id: 105, tenantId: 'B', name: 'Other', documentId: 3, companyId: 201, enabled: false },
      { id: 106, tenantId: 'B', name: 'HiddenLink', companyId: 201 },
    ]);
    await db.getCollection('links').model.bulkCreate([
      { id: 1, tenantId: 'B', documentId: 1, projectId: 101 },
      { id: 2, tenantId: 'B', documentId: 1, projectId: 101 },
      { id: 3, tenantId: 'H', name: 'Visible', documentId: 1, projectId: 102 },
      { id: 4, tenantId: 'B', documentId: 2, projectId: 103 },
      { id: 5, tenantId: 'C', documentId: 2, projectId: 106 },
      { id: 6, tenantId: null, name: 'Legacy', documentId: 4, projectId: 104 },
    ]);
    await db.getCollection('companies').model.bulkCreate([
      { id: 201, tenantId: 'B', name: 'Owned' },
      { id: 202, tenantId: 'C', name: 'Hidden' },
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
    trees = new AccessFilterTreeService(db, adapter, new AccessQueryService(db, adapter, key));
    grants = new Map();
    resolveGrant = vi.fn((collection: Collection, path: readonly string[]) =>
      grants.has(path.join('.'))
        ? grants.get(path.join('.'))
        : {
            identity: identities.find((i) => i.collectionName === collection.name)!,
            fields: [...Object.keys(collection.model.rawAttributes), ...Object.keys(collection.model.associations)],
          },
    );
    parser = new AccessRequestFilterParser(db, resolveGrant);
  });
  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "request_filter_links", "request_filter_projects", "request_filter_companies", "request_filter_documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });
  const plan = (filter: unknown) =>
    trees.scopeRoots(ctx, mainIdentity, { tenantId: 'B' }, parser.parse(mainIdentity, filter));
  const rows = async (filter: unknown) => {
    const scoped = await plan(filter);
    const records = await docs.model.findAll({ ...scoped.query, attributes: ['id'], order: [['id', 'ASC']] });
    scoped.assertCurrent();
    return records.map((row) => row.getDataValue('id'));
  };
  it('parses nested readable targets without introducing a JOIN', async () => {
    expect(parser.parse(mainIdentity, { 'projects.company.name': 'Owned' }).filter).toMatchObject({
      type: 'association',
      association: 'projects',
      condition: { type: 'association', association: 'company' },
    });
    expect(await rows({ 'projects.company.name': { $includes: 'Owned' } })).toEqual([1]);
  });
  it('preserves root and nested logical groups under G/V scopes', async () => {
    expect(await rows({ $or: [{ name: 'Hidden' }, { 'projects.company.name': 'Owned' }] })).toEqual([1]);
    expect(await rows({ $not: { 'projects.company.name': 'Owned' } })).toEqual([2, 4, 5]);
    expect(await rows({ $and: [{ amount: { $gte: 10 } }, { 'projects.enabled': true }] })).toEqual([1]);
  });
  it('groups same-path association fields into one target predicate', async () => {
    const parsed = parser.parse(mainIdentity, { 'projects.enabled': true, 'projects.name': 'Owned' });
    expect(parsed.filter).toMatchObject({
      type: 'association',
      association: 'projects',
      condition: { type: 'all', children: [{ type: 'predicate' }, { type: 'predicate' }] },
    });
    expect(await rows({ 'projects.enabled': true, 'projects.name': 'Owned' })).toEqual([1]);
  });
  it('rejects association conditions split across logical siblings', async () => {
    expect(() =>
      parser.parse(mainIdentity, {
        $and: [{ 'projects.enabled': true }, { 'projects.name': 'Owned' }],
      }),
    ).toThrow();
  });
  it('groups repeated deep association paths into the same readable target', async () => {
    expect(
      await rows({
        'projects.company.projects.name': 'Owned',
        'projects.company.projects.enabled': false,
      }),
    ).toEqual([]);
  });
  it('rejects overlapping associations between ordinary and logical conditions', () => {
    for (const logical of ['$and', '$or', '$not']) {
      const child = { 'projects.name': 'Visible' };
      expect(() =>
        parser.parse(mainIdentity, {
          'projects.enabled': true,
          [logical]: logical === '$not' ? child : [child],
        }),
      ).toThrow();
    }
  });
  it('maps association exists and not-exists to readable-target existence', async () => {
    expect(await rows({ 'projects.$exists': true })).toEqual([1, 4]);
    expect(await rows({ 'projects.$notExists': true })).toEqual([2, 5]);
    expect(await rows({ 'projects.id.$exists': true })).toEqual([1, 4]);
    expect(await rows({ 'projects.company.$notExists': true })).toEqual([1]);
    expect(await rows({ 'projects.company.id.$exists': true })).toEqual([1, 4]);
    expect(await rows({ 'projects.company.id.$notExists': true })).toEqual([1]);
  });
  it('keeps scalar exists operators distinct from association existence', async () => {
    expect(await rows({ 'name.$exists': true })).toEqual([1, 2, 4, 5]);
    expect(await rows({ 'name.$notExists': true })).toEqual([]);
    expect(await rows({ 'projects.name.$exists': true })).toEqual([1, 4]);
  });
  it('requires an explicit server read grant for every nested target and link', async () => {
    grants.set('projects.company', null);
    expect(() => parser.parse(mainIdentity, { 'projects.company.name': 'Owned' })).toThrow();
    grants.delete('projects.company');
    grants.set('projects.$through', null);
    expect(() => parser.parse(mainIdentity, { 'projects.name': 'Owned' })).toThrow();
  });
  it('rejects unsupported operators and unauthorized fields rather than dropping them', async () => {
    expect(() => parser.parse(mainIdentity, { name: { $arbitrary: true } })).toThrow();
    grants.set('', { identity: mainIdentity, fields: ['id'] });
    expect(() => parser.parse(mainIdentity, { name: 'Owned' })).toThrow();
  });
  it('requires source field authorization before following an association', () => {
    grants.set('', { identity: mainIdentity, fields: ['id'] });
    for (const filter of [
      { 'projects.name': 'Owned' },
      { 'projects.$exists': true },
      { 'projects.id.$notExists': true },
    ])
      expect(() => parser.parse(mainIdentity, filter)).toThrow();
    grants.delete('');
    grants.set('projects', { identity: identities[1], fields: ['id', 'name'] });
    expect(() => parser.parse(mainIdentity, { 'projects.company.name': 'Owned' })).toThrow();
    expect(() => parser.parse(mainIdentity, { 'projects.company.$exists': true })).toThrow();
  });
  it('rejects JSON-valued fields and non-scalar operator operands', async () => {
    grants.set('', { identity: mainIdentity, fields: ['labels', 'name'] });
    expect(() => parser.parse(mainIdentity, { labels: { $eq: 'anything' } })).toThrow();
    expect(() => parser.parse(mainIdentity, { name: { $eq: { nested: true } } })).toThrow();
  });
  it('rejects unsafe JSON input before resolving any ACL grant', async () => {
    resolveGrant.mockClear();
    const cyclic: Record<string, unknown> = {};
    cyclic.$not = cyclic;
    expect(() => parser.parse(mainIdentity, cyclic)).toThrow();
    expect(resolveGrant).not.toHaveBeenCalled();
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => parser.parse(mainIdentity, { $and: sparse })).toThrow();
    expect(resolveGrant).not.toHaveBeenCalled();
    expect(() => parser.parse(mainIdentity, { ['a'.repeat(10001)]: true })).toThrow();
    expect(resolveGrant).not.toHaveBeenCalled();
    const getter = vi.fn(() => ({ name: 'Owned' }));
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { get: getter, enumerable: true });
    expect(() => parser.parse(mainIdentity, { $and: accessor })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(resolveGrant).not.toHaveBeenCalled();
    const inherited = [{ name: 'Owned' }];
    Object.setPrototypeOf(inherited, Object.create(Array.prototype));
    expect(() => parser.parse(mainIdentity, { $and: inherited })).toThrow();
    expect(resolveGrant).not.toHaveBeenCalled();
  });
  it('binds untrusted scalar text as a value, not SQL syntax', async () => {
    expect(await rows({ name: "Owned' OR 1=1 --" })).toEqual([]);
  });
  it('bounds dotted association paths before resolving an excessive number of grants', () => {
    const path = `${Array.from({ length: 20 }, () => 'projects.company').join('.')}.name`;
    resolveGrant.mockClear();
    expect(() => parser.parse(mainIdentity, { [path]: 'Owned' })).toThrow();
    expect(resolveGrant.mock.calls.length).toBeLessThanOrEqual(16);
    resolveGrant.mockClear();
    expect(() => parser.parse(mainIdentity, { [path.replace(/\.name$/, '.$exists')]: true })).toThrow();
    expect(resolveGrant.mock.calls.length).toBeLessThanOrEqual(16);
  });
});
