import { ACL, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { AccessAssociationFilterService } from '../../access-control/association-filter';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };
const through = { ...mainIdentity, collectionKey: 'links-key', collectionName: 'links' };
const identities = [mainIdentity, target, through];
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('association existence filtering (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let links: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let filters: AccessAssociationFilterService;
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
    for (const name of ['documents', 'projects', 'links']) {
      db.collection({
        name,
        tableName: `assoc_filter_${name}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string', field: 'display_name' },
          { name: 'amount', type: 'integer' },
          { name: 'enabled', type: 'boolean' },
          { name: 'deletedAt', type: 'date', field: 'deleted_at' },
          ...(name === 'documents' ? [{ name: 'projectId', type: 'integer', field: 'project_id' }] : []),
          ...(name === 'projects' ? [{ name: 'documentId', type: 'integer', field: 'document_id' }] : []),
          ...(name === 'links'
            ? [
                { name: 'documentId', type: 'integer', field: 'document_id' },
                { name: 'projectId', type: 'integer', field: 'project_id' },
              ]
            : []),
        ],
      });
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    links = db.getCollection('links');
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
    for (const collection of [docs, projects, links]) await collection.model.sync();
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Owned', amount: 10 },
      { id: 2, tenantId: 'H', name: 'Visible', amount: 20 },
      { id: 3, tenantId: 'C', name: 'Hidden', amount: 30 },
      { id: 4, tenantId: null, name: 'Legacy', amount: 40 },
      { id: 5, tenantId: 'B', name: 'Empty', amount: 50 },
    ]);
    await projects.model.bulkCreate([
      { id: 101, documentId: 1, tenantId: 'B', name: 'Owned', enabled: true },
      { id: 102, documentId: 1, tenantId: 'H', name: 'Visible', enabled: false },
      { id: 103, documentId: 2, tenantId: 'C', name: 'Hidden' },
      { id: 104, documentId: 4, tenantId: null, name: 'Legacy' },
      { id: 105, documentId: 3, tenantId: 'B', name: 'Other' },
      { id: 106, tenantId: 'B', name: 'HiddenLink' },
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
    for (const identity of [target, through])
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
    filters = new AccessAssociationFilterService(db, adapter, queries);
    await prepare();
  });
  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "assoc_filter_links", "assoc_filter_projects", "assoc_filter_documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });

  const plan = (association = 'projects', extra = {}) =>
    filters.scopeRoots(ctx, mainIdentity, target, authenticated, {
      association,
      exists: true,
      ...(association === 'projects' ? { through } : {}),
      ...extra,
    });
  const rows = async (association = 'projects', extra = {}) => {
    const scoped = await plan(association, extra);
    scoped.assertCurrent();
    const result = await docs.model.findAll({
      ...scoped.query,
      attributes: ['id'],
      order: [['id', 'ASC']],
      hooks: false,
    });
    scoped.assertCurrent();
    return result.map((record) => record.getDataValue('id'));
  };
  it.each(['project', 'children', 'single', 'projects'])('%s only matches readable targets', async (association) => {
    expect(await rows(association)).toEqual([1, 4]);
  });
  it.each(['project', 'children', 'single', 'projects'])(
    '%s negates readable existence, including NULL keys',
    async (association) => {
      expect(await rows(association, { exists: false })).toEqual([2, 5]);
    },
  );
  it('does not multiply root pagination, count or sums for duplicate links', async () => {
    const scoped = await plan();
    expect(await docs.model.count(scoped.query)).toBe(2);
    expect(await docs.model.sum('amount', scoped.query)).toBe(50);
    expect(
      (await docs.model.findAll({ ...scoped.query, order: [['id', 'ASC']], limit: 1, offset: 1 }))[0].get('id'),
    ).toBe(4);
    scoped.assertCurrent();
  });
  it('intersects all three independently supplied ACL predicates', async () => {
    expect(
      await rows('projects', { sourceWhere: { id: 1 }, targetWhere: { id: 102 }, throughWhere: { id: 3 } }),
    ).toEqual([1]);
    expect(
      await rows('projects', { sourceWhere: { id: 1 }, targetWhere: { id: 101 }, throughWhere: { id: 3 } }),
    ).toEqual([]);
    expect(
      await rows('projects', {
        sourceWhere: { id: 1 },
        targetWhere: { id: 101 },
        throughWhere: { id: 3 },
        exists: false,
      }),
    ).toEqual([1]);
  });
  it.each(['project', 'children', 'single', 'projects'])(
    '%s cannot infer hidden fields via a request match',
    async (association) => {
      expect(await rows(association, { targetWhere: { name: 'Hidden' } })).toEqual([]);
      expect(await rows(association, { targetWhere: { name: 'Hidden' }, exists: false })).toEqual([1, 2, 4, 5]);
    },
  );
  it('preserves target and through association scopes', async () => {
    const association = docs.model.associations.projects as any;
    association.scope = { enabled: true };
    association.through.scope = { id: 1 };
    expect(await rows()).toEqual([1]);
    association.through.scope = { id: 3 };
    expect(await rows()).toEqual([]);
  });
  it('preserves all effective default scopes', async () => {
    docs.model.addScope('defaultScope', { where: { id: { [Op.ne]: 4 } } }, { override: true });
    projects.model.addScope('defaultScope', { where: { id: 101 } }, { override: true });
    links.model.addScope('defaultScope', { where: { id: 3 } }, { override: true });
    expect(await rows()).toEqual([]);
    expect(await rows('projects', { exists: false })).toEqual([1, 2, 5]);
  });
  it.each(['documents', 'projects', 'links'])('preserves %s soft deletion', async (name) => {
    const collection = db.getCollection(name);
    collection.model.options.paranoid = true;
    (collection.model as any)._timestampAttributes.deletedAt = 'deletedAt';
    await collection.model.update(
      { deletedAt: new Date() },
      { where: { id: name === 'projects' ? 104 : name === 'links' ? 6 : 4 } },
    );
    expect(await rows()).toEqual([1]);
  });
  it('keeps bindings and physical column aliases isolated', async () => {
    const quote = (name: string) => db.sequelize.getQueryInterface().quoteIdentifier(name);
    expect(
      await rows('projects', {
        sourceWhere: literal(`${quote('documents')}.${quote('record_id')} = $rootId`),
        sourceBind: { rootId: 1 },
        targetWhere: literal(`${quote('projects')}.${quote('display_name')} = $targetName`),
        targetBind: { targetName: 'Owned' },
        throughWhere: literal(`${quote('links')}.${quote('record_id')} = $tac_scope0_0`),
        throughBind: { tac_scope0_0: 1 },
      }),
    ).toEqual([1]);
  });
  it('does not claim legacy roots, targets or links during filtering', async () => {
    await rows();
    for (const [collection, id] of [
      [docs, 4],
      [projects, 104],
      [links, 6],
    ] as const)
      expect((await collection.model.findByPk(id))!.getDataValue('tenantId')).toBeNull();
  });
  it.each(['sourceWhere', 'targetWhere', 'throughWhere'])('snapshots %s before awaiting', async (property) => {
    const input = { [property]: { id: property === 'targetWhere' ? 101 : 1 } };
    const promise = rows('projects', input);
    input[property].id = 999;
    expect(await promise).toEqual([1]);
  });
  it('rejects changed configuration before execution and after SQL', async () => {
    const scoped = await plan();
    adapter.release(ctx);
    expect(() => scoped.assertCurrent()).toThrow();
  });
  it('guards relation scope and rule metadata after planning', async () => {
    const scoped = await plan();
    (docs.model.associations.projects as any).through.scope = { id: 999 };
    expect(() => scoped.assertCurrent()).toThrow();
  });
  it('rejects a changed model after planning', async () => {
    const scoped = await plan();
    projects.model.rawAttributes.name.field = 'another_column';
    expect(() => scoped.assertCurrent()).toThrow();
  });
  it.each([
    { exists: undefined },
    { exists: 1 },
    { through: undefined },
    { association: 'missing' },
    { association: 'projects.name' },
    { through: target },
    { through: { ...through, dataSourceKey: 'external' } },
    { targetBind: { same: 1 }, sourceBind: { same: 2 } },
    { targetBind: { same: 1 }, throughBind: { same: 2 } },
    { sourceBind: [] },
    { paranoid: false },
    { limit: 10 },
  ])('rejects unsupported input %j', async (extra) => {
    await expect(plan('projects', extra)).rejects.toThrow();
  });
  it('rejects through options for non-many-to-many filtering', async () => {
    await expect(plan('project', { through })).rejects.toThrow();
  });
  it('rejects an unprepared or wrongly identified target', async () => {
    adapter.release(ctx);
    await expect(plan()).rejects.toThrow();
    await prepare();
    await expect(
      filters.scopeRoots(ctx, mainIdentity, { ...target, collectionKey: 'wrong' }, authenticated, {
        association: 'project',
        exists: true,
      }),
    ).rejects.toThrow();
  });
  it('rejects missing tenant context even for a negative empty result', async () => {
    await expect(
      filters.scopeRoots(ctx, mainIdentity, target, {}, { association: 'project', exists: false }),
    ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });

  it.each([mainIdentity, target, through])(
    'empty rules on $collectionName never fall back to old tenancy',
    async (identity) => {
      const current = adapter.configuration(ctx, identity)!;
      await store.save(identity, { ...current, rules: [] }, { userId: 28 });
      await prepare();
      expect(await rows()).toEqual([]);
      expect(await rows('projects', { exists: false })).toEqual(identity === mainIdentity ? [] : [1, 2, 4, 5]);
    },
  );

  it('shared targets and links require no physical tenant column', async () => {
    for (const identity of [target, through]) {
      const config = configFor({ type: 'constant', value: true });
      await store.save(identity, { ...config, ownership: { enabled: false }, revision: 1 }, { userId: 28 });
      const collection = db.getCollection(identity.collectionName);
      await db.sequelize.getQueryInterface().removeColumn(collection.model.getTableName(), 'tenant_id');
      collection.model.removeAttribute('tenantId');
    }
    await prepare();
    expect(await rows()).toEqual([1, 2, 4]);
    expect(await rows('projects', { targetWhere: { name: 'Hidden' } })).toEqual([2]);
  });

  it('keeps rule relations as internal authorization facts independent of user filter targets', async () => {
    const config = configFor({
      type: 'exists',
      path: 'projects',
      condition: {
        type: 'compare',
        operator: 'eq',
        left: { type: 'field', path: 'name' },
        right: { type: 'literal', value: 'Hidden' },
      },
    });
    await store.save(mainIdentity, { ...config, revision: 1 }, { userId: 28 });
    await prepare();
    // D2 is readable because trusted G sees the fact, but the ordinary filter cannot see that target.
    expect(await rows('projects', { exists: false })).toEqual([2]);
    expect(await rows()).toEqual([]);
  });

  it('uses the supplied live read transaction', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await docs.model.create({ id: 6, tenantId: 'B', projectId: 101, amount: 60 }, { transaction });
      expect(await rows('project', { transaction })).toEqual([1, 4, 6]);
    } finally {
      await transaction.rollback();
    }
    expect(await rows('project')).toEqual([1, 4]);
    await expect(plan('project', { transaction })).rejects.toThrow();
  });

  it('rejects a foreign database transaction', async () => {
    const other = sqliteDatabase();
    const transaction = await other.sequelize.transaction();
    try {
      await expect(plan('project', { transaction })).rejects.toThrow();
    } finally {
      await transaction.rollback();
      await other.close();
    }
  });

  it('rechecks metadata when authorization yields', async () => {
    const original = queries.scopeQuery.bind(queries);
    const spy = vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      projects.model.rawAttributes.name.field = 'changed_after_await';
      return result;
    });
    try {
      await expect(plan()).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('rechecks request preparation when authorization yields', async () => {
    const original = queries.scopeQuery.bind(queries);
    const spy = vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      adapter.release(ctx);
      return result;
    });
    try {
      await expect(plan()).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps SQL count constant for 20 versus 100 root rows', async () => {
    await docs.model.bulkCreate(
      Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, tenantId: 'B', projectId: 101 })),
    );
    const measure = async (limit: number) => {
      const spy = vi.spyOn(db.sequelize, 'query');
      try {
        const scoped = await plan('project');
        const records = await docs.model.findAll({ ...scoped.query, limit, order: [['id', 'ASC']] });
        scoped.assertCurrent();
        expect(records).toHaveLength(limit);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    expect(await measure(20)).toBe(await measure(100));
    expect(await measure(20)).toBeLessThanOrEqual(4);
  });

  it('rejects accessors before executing them', async () => {
    let called = false;
    const extra = Object.defineProperty({}, 'targetWhere', {
      enumerable: true,
      get() {
        called = true;
        return {};
      },
    });
    // Do not spread the object: that would execute its getter before the service receives it.
    await expect(
      filters.scopeRoots(
        ctx,
        mainIdentity,
        target,
        authenticated,
        Object.assign(extra, { association: 'project', exists: true }),
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('rejects through soft-deletion bypass', async () => {
    links.model.options.paranoid = true;
    (links.model as any)._timestampAttributes.deletedAt = 'deletedAt';
    (docs.model.associations.projects as any).through.paranoid = false;
    await expect(plan()).rejects.toThrow();
  });
});
