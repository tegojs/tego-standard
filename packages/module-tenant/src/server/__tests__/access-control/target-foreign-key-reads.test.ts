import { ACL, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessTargetForeignKeyReadService } from '../../access-control/target-foreign-key-reads';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { ...mainIdentity, collectionKey: 'children-key', collectionName: 'children' };
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('target foreign-key reads (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let children: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let reads: AccessTargetForeignKeyReadService;
  let ctx: object;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const name of ['documents', 'children']) {
      const collection = db.collection({
        name,
        tableName: `read_${name}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
          ...(name === 'children' ? [{ name: 'documentId', type: 'integer', field: 'document_id' }] : []),
        ],
      });
      await collection.model.sync();
    }
    docs = db.getCollection('documents');
    children = db.getCollection('children');
    docs.setField('children', { type: 'hasMany', target: 'children', foreignKey: 'documentId' });
    docs.setField('child', { type: 'hasOne', target: 'children', foreignKey: 'documentId' });
    children.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    await docs.repository.create({
      values: [
        { id: 1, tenantId: 'B', name: 'Owned' },
        { id: 2, tenantId: 'H', name: 'Visible' },
        { id: 3, tenantId: 'C', name: 'Hidden' },
        { id: 4, tenantId: null, name: 'Legacy' },
        { id: 5, tenantId: 'B', name: 'Empty' },
      ],
    });
    await children.repository.create({
      values: [
        { id: 101, documentId: 1, tenantId: 'B', name: 'Owned', amount: 10 },
        { id: 102, documentId: 1, tenantId: 'H', name: 'Visible', amount: 20 },
        { id: 103, documentId: 1, tenantId: 'C', name: 'Hidden', amount: 100 },
        { id: 104, documentId: 1, tenantId: null, name: 'Legacy', amount: 30 },
        { id: 105, documentId: 2, tenantId: 'B', name: 'Owned', amount: 40 },
        { id: 106, documentId: 3, tenantId: 'B', name: 'Owned', amount: 50 },
        { id: 107, documentId: 4, tenantId: null, name: 'Legacy', amount: 60 },
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
    await db
      .getRepository('collections')
      .create({ values: { key: target.collectionKey, name: target.collectionName } });
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
    for (const identity of [mainIdentity, target])
      await store.save(identity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    reads = new AccessTargetForeignKeyReadService(db, adapter, queries);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target]);
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "read_children", "read_documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });

  const plan = (sourceKey: string | number = 1, extra = {}) =>
    reads.scopeTargets(ctx, mainIdentity, target, authenticated, { association: 'children', sourceKey, ...extra });
  async function ids(sourceKey: string | number = 1, extra = {}) {
    const scoped = await plan(sourceKey, extra);
    return (await children.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) =>
      row.getDataValue('id'),
    );
  }

  it('filters related targets by G or V without claiming legacy data', async () => {
    expect(await ids()).toEqual([101, 102, 104]);
    expect((await children.model.findByPk(104)).getDataValue('tenantId')).toBeNull();
  });

  it('reads visibility-only and historical sources without changing their ownership', async () => {
    expect(await ids(2)).toEqual([105]);
    expect(await ids(4)).toEqual([107]);
    expect((await docs.model.findByPk(4)).getDataValue('tenantId')).toBeNull();
  });

  it('rejects hidden or missing sources even when targets are readable', async () => {
    for (const key of [3, 999]) await expect(ids(key)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });

  it('intersects source and target ACL predicates independently', async () => {
    await expect(ids(1, { sourceWhere: { name: 'Other' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await ids(1, { targetWhere: { amount: { [Op.gt]: 10 } } })).toEqual([102, 104]);
    expect(await ids(1, { targetWhere: { id: 105 } })).toEqual([]);
  });

  it('uses the same target scope for pagination count and sum', async () => {
    const scoped = await plan();
    expect(await children.model.count(scoped.query)).toBe(3);
    expect(await children.model.sum('amount', scoped.query)).toBe(60);
    expect(
      (await children.model.findAll({ ...scoped.query, limit: 1, offset: 1, order: [['id', 'ASC']] }))[0].getDataValue(
        'id',
      ),
    ).toBe(102);
  });

  it('preserves named bindings without colliding with generated scope bindings', async () => {
    expect(
      await ids(1, {
        sourceWhere: literal('"documents"."name" = $source_name'),
        sourceBind: { source_name: 'Owned' },
        targetWhere: literal('"children"."amount" > $tac_scope0_min'),
        targetBind: { tac_scope0_min: 10 },
      }),
    ).toEqual([102, 104]);
  });

  it('does not query a fictional source for the underscore target-list protocol', async () => {
    expect(await ids('_')).toEqual([101, 102, 104, 105, 106, 107]);
    expect(await ids('_', { targetKey: 103 })).toEqual([]);
  });

  it('keeps explicit target keys within the actual relationship', async () => {
    expect(await ids(1, { targetKey: 102 })).toEqual([102]);
    expect(await ids(1, { targetKey: 105 })).toEqual([]);
    expect(await ids(5)).toEqual([]);
  });

  it('reads a HasOne target with its own visibility and preserves empty results', async () => {
    expect(await ids(2, { association: 'child' })).toEqual([105]);
    expect(await ids(5, { association: 'child' })).toEqual([]);
    await children.model.update({ tenantId: 'C' }, { where: { id: 105 } });
    expect(await ids(2, { association: 'child' })).toEqual([]);
  });

  it('preserves association scope for concrete sources and underscore reads', async () => {
    docs.setField('visibleChildren', {
      type: 'hasMany',
      target: 'children',
      foreignKey: 'documentId',
      scope: { name: 'Visible' },
    });
    expect(await ids(1, { association: 'visibleChildren' })).toEqual([102]);
    expect(await ids('_', { association: 'visibleChildren' })).toEqual([102]);
  });

  it('retains source and target default scopes', async () => {
    children.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
    expect(await ids()).toEqual([101]);
    docs.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
    await expect(ids()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });

  it('keeps the live transaction object and reads uncommitted changes through it', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await children.model.update({ documentId: 2 }, { where: { id: 101 }, transaction });
      const scoped = await plan(2, { transaction });
      expect(scoped.query.transaction).toBe(transaction);
      expect(
        (await children.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) =>
          row.getDataValue('id'),
        ),
      ).toEqual([101, 105]);
    } finally {
      await transaction.rollback();
    }
    expect(await ids(2)).toEqual([105]);
  });

  it('rejects a finished or foreign transaction', async () => {
    const transaction = await db.sequelize.transaction();
    await transaction.rollback();
    await expect(plan(1, { transaction })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    const foreignDb = sqliteDatabase();
    const foreign = await foreignDb.sequelize.transaction();
    try {
      await expect(plan('_', { transaction: foreign })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    } finally {
      await foreign.rollback();
      await foreignDb.close();
    }
  });

  it('snapshots scalar inputs predicates and bindings before the first await', async () => {
    const sourceWhere = { name: 'Owned' };
    const targetBind = { min: 10 };
    const request = {
      association: 'children',
      sourceKey: 1,
      sourceWhere,
      targetWhere: literal('"children"."amount" > $min'),
      targetBind,
    };
    const pending = reads.scopeTargets(ctx, mainIdentity, target, authenticated, request);
    request.sourceKey = 3;
    sourceWhere.name = 'Hidden';
    targetBind.min = 999;
    const scoped = await pending;
    expect(
      (await children.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) => row.getDataValue('id')),
    ).toEqual([102, 104]);
  });

  it('does not publish a plan after its prepared phase ends', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const scoped = await original(...args);
      adapter.release(ctx);
      return scoped;
    });
    await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });

  it('rejects an association scope changed during target authorization', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const scoped = await original(...args);
      if (args[1].collectionName === target.collectionName)
        Object.assign(docs.model.associations.children, { scope: { name: 'Hidden' } });
      return scoped;
    });
    await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rejects a target model identity replaced during authorization', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const scoped = await original(...args);
      Object.assign(children, { model: docs.model });
      return scoped;
    });
    try {
      await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    } finally {
      Object.assign(children, { model: db.sequelize.models.children });
    }
  });

  it('requires a verified active tenant when a rule needs it', async () => {
    for (const identity of [{}, { tenantId: 'missing' }]) {
      await expect(
        reads.scopeTargets(ctx, mainIdentity, target, identity, { association: 'children', sourceKey: '_' }),
      ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    }
  });

  it('rejects the wrong relation target and cross-data-source identity', async () => {
    await expect(plan(1, { association: 'document' })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    await expect(
      reads.scopeTargets(ctx, mainIdentity, { ...target, dataSourceKey: 'external' }, authenticated, {
        association: 'children',
        sourceKey: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    await expect(
      reads.scopeTargets(ctx, mainIdentity, mainIdentity, authenticated, { association: 'children', sourceKey: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it.each([{ sourceKey: null }, { sourceKey: 1.5 }, { targetKey: '_' }, { include: ['document'] }, { limit: 10 }])(
    'rejects unsupported selection %j',
    async (extra) => {
      await expect(plan(1, extra)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    },
  );

  it('rejects positional SQL bindings', async () => {
    await expect(plan(1, { targetBind: [1] })).rejects.toMatchObject({ code: 'INVALID_ACCESS_RULE' });
  });

  it('keeps authorization query count independent of the number of returned targets', async () => {
    const messages: string[] = [];
    const logging = db.sequelize.options.logging;
    db.sequelize.options.logging = (sql) => messages.push(sql);
    try {
      await ids();
      const before = messages.length;
      await children.repository.create({
        values: Array.from({ length: 50 }, (_, i) => ({
          id: 200 + i,
          documentId: 1,
          tenantId: 'B',
          name: 'Owned',
          amount: 1,
        })),
      });
      messages.length = 0;
      expect(await ids()).toHaveLength(53);
      expect(messages).toHaveLength(before);
      expect(before).toBeLessThanOrEqual(4);
    } finally {
      db.sequelize.options.logging = logging;
    }
  });

  it('denies targets when their migrated configuration has no rules', async () => {
    const config = await store.read(target);
    await store.save(target, { ...config, rules: [] }, { userId: 28 });
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, target]);
    expect(await ids()).toEqual([]);
  });

  it('rejects an unprepared collection instead of falling back to old behavior', async () => {
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity]);
    await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });
});
