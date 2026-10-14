import { ACL, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessManyToManyReadService } from '../../access-control/many-to-many-reads';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };
const through = { ...mainIdentity, collectionKey: 'links-key', collectionName: 'links' };
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('many-to-many reads (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let links: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let reads: AccessManyToManyReadService;
  let ctx: object;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const name of ['documents', 'projects', 'links']) {
      db.collection({
        name,
        tableName: `m2m_read_${name}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
          ...(name === 'links'
            ? [
                { name: 'documentId', type: 'integer', field: 'document_id' },
                { name: 'projectId', type: 'integer', field: 'project_id' },
                { name: 'deletedAt', type: 'date', field: 'deleted_at' },
              ]
            : []),
        ],
      });
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    links = db.getCollection('links');
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
    });
    for (const collection of [docs, projects, links]) await collection.model.sync();
    await docs.repository.create({
      values: [
        { id: 1, tenantId: 'B', name: 'Owned' },
        { id: 2, tenantId: 'H', name: 'Visible' },
        { id: 3, tenantId: 'C', name: 'Hidden' },
        { id: 4, tenantId: null, name: 'Legacy' },
        { id: 5, tenantId: 'B', name: 'Empty' },
      ],
    });
    await projects.repository.create({
      values: [
        { id: 101, tenantId: 'B', name: 'Owned', amount: 10 },
        { id: 102, tenantId: 'H', name: 'Visible', amount: 20 },
        { id: 103, tenantId: 'C', name: 'Hidden', amount: 100 },
        { id: 104, tenantId: null, name: 'Legacy', amount: 30 },
        { id: 105, tenantId: 'B', name: 'Other', amount: 40 },
        { id: 106, tenantId: 'B', name: 'HiddenLink', amount: 50 },
        { id: 107, tenantId: 'B', name: 'Unlinked', amount: 60 },
      ],
    });
    await links.repository.create({
      values: [
        { id: 1, documentId: 1, projectId: 101, tenantId: 'B', name: 'Owned' },
        { id: 2, documentId: 1, projectId: 101, tenantId: 'H', name: 'Visible' },
        { id: 3, documentId: 1, projectId: 102, tenantId: 'H', name: 'Visible' },
        { id: 4, documentId: 1, projectId: 103, tenantId: 'B', name: 'Owned' },
        { id: 5, documentId: 1, projectId: 104, tenantId: null, name: 'Legacy' },
        { id: 6, documentId: 2, projectId: 105, tenantId: 'B', name: 'Owned' },
        { id: 7, documentId: 3, projectId: 105, tenantId: 'B', name: 'Owned' },
        { id: 8, documentId: 4, projectId: 104, tenantId: null, name: 'Legacy' },
        { id: 9, documentId: 1, projectId: 106, tenantId: 'C', name: 'Hidden' },
      ],
    });
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.repository.create({
      values: [
        { id: 'H', parentId: null, enabled: true },
        { id: 'B', parentId: 'H', enabled: true },
        { id: 'C', parentId: 'H', enabled: true },
      ],
    });
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
    for (const identity of [mainIdentity, target, through])
      await store.save(identity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    reads = new AccessManyToManyReadService(db, adapter, queries);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target, through]);
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "m2m_read_links", "m2m_read_projects", "m2m_read_documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });

  const plan = (sourceKey: string | number = 1, extra = {}) =>
    reads.scopeTargets(ctx, mainIdentity, target, through, authenticated, {
      association: 'projects',
      sourceKey,
      ...extra,
    });
  async function ids(sourceKey: string | number = 1, extra = {}) {
    const scoped = await plan(sourceKey, extra);
    return (await projects.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) =>
      row.getDataValue('id'),
    );
  }

  it('intersects target and through G or V and never claims historical records', async () => {
    expect(await ids()).toEqual([101, 102, 104]);
    expect((await projects.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
    expect((await links.model.findByPk(5)).getDataValue('tenantId')).toBeNull();
  });
  it('reads visible and historical sources without claiming them', async () => {
    expect(await ids(2)).toEqual([105]);
    expect(await ids(4)).toEqual([104]);
    expect((await docs.model.findByPk(4)).getDataValue('tenantId')).toBeNull();
  });
  it('rejects hidden or missing sources', async () => {
    for (const key of [3, 999]) await expect(ids(key)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('intersects three independent ACL predicates', async () => {
    await expect(ids(1, { sourceWhere: { name: 'Other' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await ids(1, { targetWhere: { amount: { [Op.gt]: 10 } } })).toEqual([102, 104]);
    expect(await ids(1, { throughWhere: { name: 'Owned' } })).toEqual([101]);
    expect(await ids(1, { throughWhere: { name: 'Hidden' } })).toEqual([]);
  });
  it('does not duplicate list pagination count or sum for repeated links', async () => {
    const scoped = await plan();
    expect(await projects.model.count(scoped.query)).toBe(3);
    expect(await projects.model.sum('amount', scoped.query)).toBe(60);
    expect(
      (await projects.model.findAll({ ...scoped.query, limit: 1, offset: 1, order: [['id', 'ASC']] }))[0].getDataValue(
        'id',
      ),
    ).toBe(102);
  });
  it('restricts concrete reads to the real source and explicit target', async () => {
    expect(await ids(1, { targetKey: 102 })).toEqual([102]);
    expect(await ids(1, { targetKey: 105 })).toEqual([]);
    expect(await ids(5)).toEqual([]);
  });
  it('treats underscore as a direct target read even without a readable link', async () => {
    expect(await ids('_')).toEqual([101, 102, 104, 105, 106, 107]);
    expect(await ids('_', { targetKey: 103 })).toEqual([]);
  });
  it('preserves source through and target named bindings and avoids generated prefixes', async () => {
    expect(
      await ids(1, {
        sourceWhere: literal('"documents"."name" = $same'),
        sourceBind: { same: 'Owned' },
        throughWhere: literal('"links"."name" = $tac_scope0_name'),
        throughBind: { tac_scope0_name: 'Visible' },
        targetWhere: literal('"projects"."amount" > $minimum'),
        targetBind: { minimum: 10 },
      }),
    ).toEqual([102]);
  });
  it('rejects colliding through and target bindings rather than overwriting', async () => {
    await expect(plan(1, { throughBind: { key: 'Visible' }, targetBind: { key: 101 } })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
  });
  it('preserves target and through association scopes', async () => {
    docs.setField('visibleProjects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
      scope: { name: 'Visible' },
      throughScope: { name: 'Visible' },
    });
    expect(await ids(1, { association: 'visibleProjects' })).toEqual([102]);
    expect(await ids('_', { association: 'visibleProjects' })).toEqual([102]);
    await links.model.update({ name: 'Owned', tenantId: 'B' }, { where: { id: 3 } });
    expect(await ids(1, { association: 'visibleProjects' })).toEqual([]);
  });
  it('retains all model default scopes', async () => {
    links.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
    expect(await ids()).toEqual([101]);
    projects.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
    expect(await ids()).toEqual([]);
    docs.model.addScope('defaultScope', { where: { name: 'Hidden' } }, { override: true });
    await expect(ids()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('retains through soft deletion', async () => {
    links.model.options.paranoid = true;
    (links.model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt =
      'deletedAt';
    await links.model.update({ deletedAt: new Date() }, { where: { id: 3 } });
    expect(await ids()).toEqual([101, 104]);
  });
  it('reads uncommitted relationship changes using the live transaction', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await links.model.update({ documentId: 2 }, { where: { id: 1 }, transaction });
      const scoped = await plan(2, { transaction });
      expect(scoped.query.transaction).toBe(transaction);
      expect(
        (await projects.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) =>
          row.getDataValue('id'),
        ),
      ).toEqual([101, 105]);
    } finally {
      await transaction.rollback();
    }
    expect(await ids(2)).toEqual([105]);
  });
  it('rejects finished transactions', async () => {
    const transaction = await db.sequelize.transaction();
    await transaction.rollback();
    await expect(plan(1, { transaction })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });
  it('requires tenant context for enabled ownership rules', async () => {
    await expect(
      reads.scopeTargets(ctx, mainIdentity, target, through, {}, { association: 'projects', sourceKey: 1 }),
    ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });
  it('rejects missing or unmigrated through configuration', async () => {
    const unprepared = {};
    await adapter.prepare(unprepared, [mainIdentity, target]);
    await expect(
      reads.scopeTargets(unprepared, mainIdentity, target, through, authenticated, {
        association: 'projects',
        sourceKey: 1,
      }),
    ).rejects.toThrow();
    await db.getCollection('collections').model.update({ options: {} }, { where: { key: through.collectionKey } });
    const migrated = {};
    await adapter.prepare(migrated, [mainIdentity, target, through]);
    await expect(
      reads.scopeTargets(migrated, mainIdentity, target, through, authenticated, {
        association: 'projects',
        sourceKey: 1,
      }),
    ).rejects.toThrow();
  });
  it('supports an explicit shared through model while preserving its ACL', async () => {
    await store.save(
      through,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
      { userId: 28 },
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target, through]);
    expect(await ids()).toEqual([101, 102, 104, 106]);
    expect(await ids(1, { throughWhere: { name: 'Owned' } })).toEqual([101]);
  });

  it('compiles the through model own relational visibility without shadowing target correlations', async () => {
    links.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    await store.save(
      through,
      {
        ...configFor(
          {
            type: 'exists',
            path: 'document',
            condition: {
              type: 'compare',
              operator: 'eq',
              left: { type: 'field', path: 'name' },
              right: { type: 'literal', value: 'Visible' },
            },
          },
          'visibility',
        ),
        revision: 1,
      },
      { userId: 28 },
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target, through]);
    expect(await ids(1)).toEqual([]);
    expect(await ids(2)).toEqual([105]);
  });

  it('rejects an association override bypassing through soft deletion', async () => {
    links.model.options.paranoid = true;
    (links.model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt =
      'deletedAt';
    docs.setField('deletedProjects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
      throughParanoid: false,
    });
    await expect(plan(1, { association: 'deletedProjects' })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
  });
  it.each(['association', 'targetKey', 'sourceKey', 'include', 'limit'])('rejects invalid %s input', async (field) => {
    await expect(
      plan(1, {
        [field]: field === 'association' ? 'missing' : field === 'sourceKey' ? [] : field === 'targetKey' ? '_' : [],
      }),
    ).rejects.toThrow();
  });
  it('rejects a forged through identity and cross-data-source identities', async () => {
    for (const identity of [
      { ...through, collectionKey: 'wrong' },
      { ...through, dataSourceKey: 'other' },
      { ...target },
    ])
      await expect(
        reads.scopeTargets(ctx, mainIdentity, target, identity, authenticated, {
          association: 'projects',
          sourceKey: 1,
        }),
      ).rejects.toThrow();
  });
  it('rejects association replacement during async authorization', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      delete docs.model.associations.projects;
      return result;
    });
    await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('snapshots caller predicates before the first await', async () => {
    const input = { targetWhere: { name: 'Visible' }, throughWhere: { name: 'Visible' } };
    const pending = ids(1, input);
    input.targetWhere.name = 'Owned';
    input.throughWhere.name = 'Owned';
    expect(await pending).toEqual([102]);
  });

  it.each([mainIdentity, target, through])(
    'denies reads when $collectionName has no enabled rules',
    async (identity) => {
      await store.save(identity, { ...(await store.read(identity)), rules: [] }, { userId: 28 });
      ctx = {};
      await adapter.prepare(ctx, [mainIdentity, target, through]);
      if (identity === mainIdentity) await expect(ids()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      else expect(await ids()).toEqual([]);
    },
  );

  it.each(['sourceBind', 'targetBind', 'throughBind'])('rejects positional bindings in %s', async (field) => {
    await expect(plan(1, { [field]: [1] })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('does not publish a query after its prepared phase ends', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      adapter.release(ctx);
      return result;
    });
    await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });

  it.each(['projects', 'links'])('rejects %s model replacement after authorization', async (name) => {
    const collection = db.getCollection(name);
    const model = collection.model;
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].collectionName === name) Object.assign(collection, { model: docs.model });
      return result;
    });
    try {
      await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    } finally {
      Object.assign(collection, { model });
    }
  });

  it.each(['scope', 'throughScope', 'column', 'defaultScope'])(
    'rejects changed %s metadata across authorization awaits',
    async (kind) => {
      const original = queries.scopeQuery.bind(queries);
      const oldColumn = links.model.rawAttributes.documentId.field;
      vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (args[1].collectionName === target.collectionName) {
          const association = docs.model.associations.projects as unknown as {
            scope: object;
            through: { scope: object };
          };
          if (kind === 'scope') association.scope = { name: 'Hidden' };
          if (kind === 'throughScope') association.through.scope = { name: 'Hidden' };
          if (kind === 'column') links.model.rawAttributes.documentId.field = 'other_column';
          if (kind === 'defaultScope')
            links.model.addScope('defaultScope', { where: { name: 'Hidden' } }, { override: true });
        }
        return result;
      });
      try {
        await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      } finally {
        links.model.rawAttributes.documentId.field = oldColumn;
      }
    },
  );

  it('keeps authorization query count constant as target count grows', async () => {
    const messages: string[] = [];
    const logging = db.sequelize.options.logging;
    db.sequelize.options.logging = (sql) => messages.push(sql);
    try {
      await ids();
      const before = messages.length;
      await projects.repository.create({
        values: Array.from({ length: 50 }, (_, i) => ({ id: 200 + i, tenantId: 'B', name: 'Owned', amount: 1 })),
      });
      await links.repository.create({
        values: Array.from({ length: 50 }, (_, i) => ({
          id: 200 + i,
          documentId: 1,
          projectId: 200 + i,
          tenantId: 'B',
          name: 'Owned',
        })),
      });
      messages.length = 0;
      expect(await ids()).toHaveLength(53);
      expect(messages).toHaveLength(before);
      expect(before).toBeLessThanOrEqual(5);
    } finally {
      db.sequelize.options.logging = logging;
    }
  });

  it('rejects foreign transactions even for direct target reads', async () => {
    const foreignDb = sqliteDatabase();
    const transaction = await foreignDb.sequelize.transaction();
    try {
      await expect(plan('_', { transaction })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    } finally {
      await transaction.rollback();
      await foreignDb.close();
    }
  });
});
