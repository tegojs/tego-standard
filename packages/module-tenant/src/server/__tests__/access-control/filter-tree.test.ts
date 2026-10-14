import { ACL, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessFilterTreeService, type AccessFilterNode } from '../../access-control/filter-tree';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };
const through = { ...mainIdentity, collectionKey: 'links-key', collectionName: 'links' };
const company = { ...mainIdentity, collectionKey: 'companies-key', collectionName: 'companies' };
const identities = [mainIdentity, target, through, company];
const authenticated = { tenantId: 'B' };
const predicate = (where: object): AccessFilterNode => ({ type: 'predicate', where });
const association = (name = 'projects', extra = {}): AccessFilterNode => ({
  type: 'association',
  association: name,
  target: { ...target },
  exists: true,
  ...(name === 'projects' ? { through: { ...through } } : {}),
  ...extra,
});
const customer = (extra = {}): AccessFilterNode => ({
  type: 'association',
  association: 'company',
  target: { ...company },
  exists: true,
  ...extra,
});

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('composed association filtering (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let links: Collection;
  let companies: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let trees: AccessFilterTreeService;
  let ctx: object;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });
  const prepare = async () => {
    if (ctx) adapter.release(ctx);
    ctx = {};
    await adapter.prepare(ctx, identities);
  };
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const name of ['documents', 'projects', 'links', 'companies'])
      db.collection({
        name,
        tableName: `filter_tree_${name}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string', field: 'display_name' },
          { name: 'amount', type: 'integer' },
          { name: 'enabled', type: 'boolean' },
          { name: 'deletedAt', type: 'date', field: 'deleted_at' },
          ...(name === 'documents' || name === 'links'
            ? [{ name: 'projectId', type: 'integer', field: 'project_id' }]
            : []),
          ...(name === 'projects' ? [{ name: 'companyId', type: 'integer', field: 'company_id' }] : []),
          ...(name === 'projects' || name === 'links' || name === 'companies'
            ? [{ name: 'documentId', type: 'integer', field: 'document_id' }]
            : []),
        ],
      });
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    links = db.getCollection('links');
    companies = db.getCollection('companies');
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
    projects.setField('company', { type: 'belongsTo', target: 'companies', foreignKey: 'companyId' });
    projects.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    companies.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    for (const collection of [docs, projects, links, companies]) await collection.model.sync();
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Owned', amount: 10 },
      { id: 2, tenantId: 'H', name: 'Visible', amount: 20 },
      { id: 3, tenantId: 'C', name: 'Hidden', amount: 30 },
      { id: 4, tenantId: null, name: 'Legacy', amount: 40 },
      { id: 5, tenantId: 'B', name: 'Empty', amount: 50 },
    ]);
    await companies.model.bulkCreate([
      { id: 201, documentId: 1, tenantId: 'B', name: 'Owned', enabled: true },
      { id: 202, documentId: 1, tenantId: 'C', name: 'Hidden', enabled: true },
      { id: 203, documentId: 4, tenantId: null, name: 'Legacy', enabled: false },
    ]);
    await projects.model.bulkCreate([
      { id: 101, documentId: 1, companyId: 201, tenantId: 'B', name: 'Owned', enabled: true },
      { id: 102, documentId: 1, companyId: 202, tenantId: 'H', name: 'Visible', enabled: false },
      { id: 103, documentId: 2, companyId: 201, tenantId: 'C', name: 'Hidden', enabled: true },
      { id: 104, documentId: 4, companyId: 203, tenantId: null, name: 'Legacy', enabled: false },
      { id: 105, documentId: 3, companyId: 201, tenantId: 'B', name: 'Other', enabled: true },
      { id: 106, companyId: 201, tenantId: 'B', name: 'HiddenLink' },
    ]);
    for (const [id, projectId] of [
      [1, 101],
      [2, 103],
      [3, 105],
      [4, 104],
    ])
      await docs.model.update({ projectId }, { where: { id } });
    await links.model.bulkCreate([
      { id: 1, documentId: 1, projectId: 101, tenantId: 'B' },
      { id: 2, documentId: 1, projectId: 101, tenantId: 'B' },
      { id: 3, documentId: 1, projectId: 102, tenantId: 'H', name: 'Visible' },
      { id: 4, documentId: 2, projectId: 103, tenantId: 'B' },
      { id: 5, documentId: 2, projectId: 106, tenantId: 'C' },
      { id: 6, documentId: 4, projectId: 104, tenantId: null, name: 'Legacy' },
      { id: 7, documentId: 3, projectId: 105, tenantId: 'B' },
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
    for (const identity of identities.slice(1))
      await db
        .getRepository('collections')
        .create({ values: { key: identity.collectionKey, name: identity.collectionName } });
    store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: stableKey }),
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
    queries = new AccessQueryService(db, adapter, stableKey);
    trees = new AccessFilterTreeService(db, adapter, queries);
    await prepare();
  });
  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "filter_tree_links", "filter_tree_projects", "filter_tree_companies", "filter_tree_documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });
  const plan = (filter: AccessFilterNode, extra = {}) =>
    trees.scopeRoots(ctx, mainIdentity, authenticated, { filter, ...extra });
  const rows = async (filter: AccessFilterNode, extra = {}) => {
    const scoped = await plan(filter, extra);
    scoped.assertCurrent();
    const records = await docs.model.findAll({
      ...scoped.query,
      attributes: ['id'],
      order: [['id', 'ASC']],
      hooks: false,
    });
    scoped.assertCurrent();
    return records.map((record) => record.getDataValue('id'));
  };
  it('intersects root ACL and G/V outside an OR request', async () => {
    expect(
      await rows(
        { type: 'any', children: [predicate({ id: 3 }), predicate({ id: 1 }), predicate({ id: 4 })] },
        { sourceWhere: { id: { [Op.ne]: 4 } } },
      ),
    ).toEqual([1]);
  });
  it.each(['project', 'children', 'single', 'projects'])('%s follows readable nested companies', async (name) => {
    expect(await rows(association(name, { condition: customer({ condition: predicate({ enabled: true }) }) }))).toEqual(
      [1],
    );
  });
  it('does not combine conditions from different targets', async () => {
    expect(
      await rows(
        association('projects', {
          condition: {
            type: 'all',
            children: [predicate({ enabled: false }), customer({ condition: predicate({ enabled: true }) })],
          },
        }),
      ),
    ).toEqual([]);
  });
  it('allows separate existence clauses to match separate readable targets', async () => {
    expect(
      await rows({
        type: 'all',
        children: [
          association('projects', { condition: predicate({ enabled: false }) }),
          association('projects', { condition: customer({ condition: predicate({ enabled: true }) }) }),
        ],
      }),
    ).toEqual([1]);
  });
  it('does not pass through a hidden middle target to a visible company', async () => {
    expect(await rows(association('project', { condition: customer() }))).toEqual([1, 4]);
    expect(await rows(association('projects', { exists: false, condition: customer() }))).toEqual([2, 5]);
  });
  it('negates an association match within the target readable boundary', async () => {
    expect(await rows(association('projects', { condition: customer({ exists: false }) }))).toEqual([1]);
    expect(await rows({ type: 'not', child: association('projects', { condition: customer() }) })).toEqual([2, 5]);
  });
  it('supports paths that return to the root table without alias capture', async () => {
    const back: AccessFilterNode = {
      type: 'association',
      association: 'document',
      target: mainIdentity,
      exists: true,
      condition: predicate({ id: 4 }),
    };
    expect(await rows(association('project', { condition: back }))).toEqual([4]);
    expect(await rows(association('projects', { condition: customer({ condition: back }) }))).toEqual([4]);
  });
  it('does not leak a hidden root through a returning path', async () => {
    await companies.model.update({ documentId: 3 }, { where: { id: 201 } });
    expect(
      await rows(
        association('project', {
          condition: customer({
            condition: { type: 'association', association: 'document', target: mainIdentity, exists: true },
          }),
        }),
      ),
    ).toEqual([4]);
  });
  it('keeps repeated links out of pagination, counts and sums', async () => {
    const scoped = await plan(association('projects', { condition: customer() }));
    expect(await docs.model.count(scoped.query)).toBe(2);
    expect(await docs.model.sum('amount', scoped.query)).toBe(50);
    expect(
      (await docs.model.findAll({ ...scoped.query, order: [['id', 'ASC']], limit: 1, offset: 1 }))[0].get('id'),
    ).toBe(4);
    scoped.assertCurrent();
  });
  it('empty AND/OR preserve logical identities within root permissions', async () => {
    expect(await rows({ type: 'all', children: [] })).toEqual([1, 2, 4, 5]);
    expect(await rows({ type: 'any', children: [] })).toEqual([]);
    expect(await rows({ type: 'not', child: { type: 'any', children: [] } })).toEqual([1, 2, 4, 5]);
  });
  it('retains SQL NULL semantics when negating a scalar predicate', async () => {
    expect(await rows({ type: 'not', child: predicate({ projectId: 101 }) })).toEqual([2, 4]);
  });
  it('checks invalid branches even when another OR branch is always true', async () => {
    await expect(
      plan({
        type: 'any',
        children: [
          { type: 'all', children: [] },
          association('project', { target: { ...target, collectionKey: 'wrong' } }),
        ],
      }),
    ).rejects.toThrow();
  });
  it('applies independent ACL on root, target, through and nested company', async () => {
    expect(
      await rows(
        association('projects', {
          targetWhere: { id: 101 },
          throughWhere: { id: 2 },
          condition: customer({ targetWhere: { id: 201 } }),
        }),
        { sourceWhere: { id: 1 } },
      ),
    ).toEqual([1]);
    expect(
      await rows(association('projects', { targetWhere: { id: 101 }, throughWhere: { id: 3 }, condition: customer() })),
    ).toEqual([]);
    expect(await rows(association('projects', { condition: customer({ targetWhere: { id: 999 } }) }))).toEqual([]);
  });

  it('inner empty rules do not become an unrestricted filter', async () => {
    await store.save(company, { ...adapter.configuration(ctx, company)!, rules: [] }, { userId: 28 });
    await prepare();
    expect(await rows(association('projects', { condition: customer() }))).toEqual([]);
    expect(await rows(association('projects', { exists: false, condition: customer() }))).toEqual([1, 2, 4, 5]);
  });

  it('supports entirely shared paths without tenant columns or identity', async () => {
    for (const identity of identities) {
      const config = configFor({ type: 'constant', value: true });
      await store.save(identity, { ...config, ownership: { enabled: false }, revision: 1 }, { userId: 28 });
      const collection = db.getCollection(identity.collectionName);
      await db.sequelize.getQueryInterface().removeColumn(collection.model.getTableName(), 'tenant_id');
      collection.model.removeAttribute('tenantId');
    }
    await prepare();
    const scoped = await trees.scopeRoots(
      ctx,
      mainIdentity,
      {},
      { filter: association('project', { condition: customer() }) },
    );
    expect((await docs.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) => row.get('id'))).toEqual(
      [1, 2, 3, 4],
    );
    scoped.assertCurrent();
  });

  it('preserves a nested default scope and parent association scope', async () => {
    companies.model.addScope('defaultScope', { where: { enabled: false } }, { override: true });
    (docs.model.associations.projects as any).scope = { enabled: false };
    expect(await rows(association('projects', { condition: customer() }))).toEqual([4]);
  });

  it('preserves nested target soft deletion', async () => {
    companies.model.options.paranoid = true;
    (companies.model as any)._timestampAttributes.deletedAt = 'deletedAt';
    await companies.model.update({ deletedAt: new Date() }, { where: { id: 203 } });
    expect(await rows(association('projects', { condition: customer() }))).toEqual([1]);
  });

  it('binds independent root, target, link and nested predicates without collisions', async () => {
    const quote = (name: string) => db.sequelize.getQueryInterface().quoteIdentifier(name);
    expect(
      await rows(
        association('projects', {
          targetWhere: literal(`${quote('projects')}.${quote('record_id')} = $projectId`),
          targetBind: { projectId: 101 },
          throughWhere: literal(`${quote('links')}.${quote('record_id')} = $linkId`),
          throughBind: { linkId: 1 },
          condition: customer({
            targetWhere: literal(`${quote('companies')}.${quote('record_id')} = $companyId`),
            targetBind: { companyId: 201 },
            condition: {
              type: 'predicate',
              where: literal(`${quote('companies')}.${quote('display_name')} = $customerName`),
              bind: { customerName: 'Owned' },
            },
          }),
        }),
        {
          sourceWhere: literal(`${quote('documents')}.${quote('record_id')} = $tac_scope0_0`),
          sourceBind: { tac_scope0_0: 1 },
        },
      ),
    ).toEqual([1]);
  });

  it('snapshots the complete tree before its first authorization await', async () => {
    const filter = association('projects', { condition: customer({ condition: predicate({ enabled: true }) }) });
    const input = { sourceWhere: { id: 1 } };
    const promise = rows(filter, input);
    (filter as any).condition.condition.where.enabled = false;
    (filter as any).through.collectionKey = 'mutated';
    input.sourceWhere.id = 999;
    expect(await promise).toEqual([1]);
  });

  it('snapshots the authenticated identity', async () => {
    const identity = { tenantId: 'B' };
    const promise = trees.scopeRoots(ctx, mainIdentity, identity, {
      filter: association('project', { condition: customer() }),
    });
    identity.tenantId = 'C';
    const scoped = await promise;
    expect((await docs.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) => row.get('id'))).toEqual(
      [1, 4],
    );
    scoped.assertCurrent();
  });

  it('captures a later sibling relation before the first branch yields', async () => {
    const original = queries.scopeQuery.bind(queries);
    const spy = vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      (docs.model.associations.projects as any).through.scope = { id: 999 };
      return result;
    });
    try {
      await expect(
        plan({ type: 'all', children: [association('project', { condition: customer() }), association()] }),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a changed deep relation after planning', async () => {
    const scoped = await plan(association('project', { condition: customer() }));
    (projects.model.associations.company as any).scope = { id: 999 };
    expect(() => scoped.assertCurrent()).toThrow();
  });

  it('rejects a changed deep model after SQL completes', async () => {
    const scoped = await plan(association('project', { condition: customer() }));
    await docs.model.findAll(scoped.query);
    companies.model.rawAttributes.name.field = 'changed';
    expect(() => scoped.assertCurrent()).toThrow();
  });

  it('rejects a released preparation phase after planning', async () => {
    const scoped = await plan(association('project', { condition: customer() }));
    adapter.release(ctx);
    expect(() => scoped.assertCurrent()).toThrow();
  });

  it('uses one transaction throughout every level of the path', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await companies.model.create({ id: 204, tenantId: 'B', enabled: true }, { transaction });
      await projects.model.create({ id: 107, companyId: 204, tenantId: 'B' }, { transaction });
      await docs.model.create({ id: 6, projectId: 107, tenantId: 'B' }, { transaction });
      expect(await rows(association('project', { condition: customer() }), { transaction })).toEqual([1, 4, 6]);
    } finally {
      await transaction.rollback();
    }
    expect(await rows(association('project', { condition: customer() }))).toEqual([1, 4]);
    await expect(plan(association(), { transaction })).rejects.toThrow();
  });

  it('never claims legacy data at any level', async () => {
    await rows(association('projects', { condition: customer() }));
    for (const [collection, id] of [
      [docs, 4],
      [projects, 104],
      [links, 6],
      [companies, 203],
    ] as const)
      expect((await collection.model.findByPk(id))!.getDataValue('tenantId')).toBeNull();
  });

  it.each(['project', 'children', 'single', 'projects'])(
    '%s SQL count stays constant for 20 and 100 roots',
    async (name) => {
      await docs.model.bulkCreate(
        Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, projectId: 101, tenantId: 'B' })),
      );
      await projects.model.bulkCreate(
        Array.from({ length: 100 }, (_, i) => ({ id: 2000 + i, documentId: 1000 + i, companyId: 201, tenantId: 'B' })),
      );
      await links.model.bulkCreate(
        Array.from({ length: 100 }, (_, i) => ({
          id: 3000 + i,
          documentId: 1000 + i,
          projectId: 2000 + i,
          tenantId: 'B',
        })),
      );
      const measure = async (limit: number) => {
        const spy = vi.spyOn(db.sequelize, 'query');
        try {
          const scoped = await plan(association(name, { condition: customer() }));
          const records = await docs.model.findAll({ ...scoped.query, order: [['id', 'ASC']], limit });
          expect(records).toHaveLength(limit);
          scoped.assertCurrent();
          return spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }
      };
      expect(await measure(20)).toBe(await measure(100));
      expect(await measure(20)).toBeLessThanOrEqual(5);
    },
  );

  it.each([
    {},
    { type: 'unknown' },
    { type: 'predicate' },
    { type: 'predicate', where: null },
    { type: 'all', children: {} },
    { type: 'any', children: [undefined] },
    { type: 'not' },
    { type: 'all', children: [], paranoid: false },
    { type: 'association', association: 'project', target, exists: 1 },
    { type: 'association', association: 'project.company', target, exists: true },
    { type: 'association', association: 'project', target, exists: true, through },
    { type: 'association', association: 'projects', target, exists: true },
    { type: 'association', association: 'project', target: { ...target, dataSourceKey: 'external' }, exists: true },
    { type: 'all', children: Array.from({ length: 100 }, () => ({ type: 'predicate', where: {} })) },
  ])('rejects invalid or unsupported trees %j', async (filter) => {
    await expect(plan(filter as AccessFilterNode)).rejects.toThrow();
  });

  it('rejects sparse groups, accessors and cycles without executing a getter', async () => {
    const sparse: AccessFilterNode[] = [];
    sparse.length = 1;
    await expect(plan({ type: 'all', children: sparse })).rejects.toThrow();
    let called = false;
    const accessor = Object.defineProperty({ type: 'not' }, 'child', {
      get() {
        called = true;
        return predicate({});
      },
    });
    await expect(plan(accessor as AccessFilterNode)).rejects.toThrow();
    expect(called).toBe(false);
    const cycle = { type: 'not' as const, child: null as AccessFilterNode };
    cycle.child = cycle;
    await expect(plan(cycle)).rejects.toThrow();
  });

  it('enforces the exact depth boundary', async () => {
    let filter = predicate({ id: 1 });
    for (let i = 0; i < 8; i++) filter = { type: 'not', child: filter };
    expect(await rows(filter)).toEqual([1]);
    await expect(plan({ type: 'not', child: filter })).rejects.toThrow();
  });

  it('rejects duplicate explicit bindings across sibling clauses before SQL', async () => {
    const spy = vi.spyOn(db.sequelize, 'query');
    try {
      await expect(
        plan({
          type: 'any',
          children: [
            { type: 'predicate', where: literal('1 = $same'), bind: { same: 1 } },
            { type: 'predicate', where: literal('2 = $same'), bind: { same: 2 } },
          ],
        }),
      ).rejects.toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
