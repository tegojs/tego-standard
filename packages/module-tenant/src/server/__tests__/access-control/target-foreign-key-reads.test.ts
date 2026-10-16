import { ACL, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessEntryReadPermission } from '../../access-control/read-grants';
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
  let entry: AccessEntryReadService;
  let permissions: Map<string, AccessEntryReadPermission | null>;
  let permissionResolver: ReturnType<typeof vi.fn>;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
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
          ...(name === 'children'
            ? [
                { name: 'documentId', type: 'integer', field: 'document_id' },
                { name: 'occurredAt', type: 'date', field: 'occurred_at' },
              ]
            : []),
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
    permissions = new Map();
    permissionResolver = vi.fn((_collection: Collection, path: readonly string[], _operation: object) =>
      permissions.has(path.join('.')) ? permissions.get(path.join('.'))! : { allowed: true, params: {} },
    );
    entry = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => [mainIdentity, target].find((identity) => identity.collectionName === collection.name),
      permissionResolver,
    );
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

  const page = (sourceKey: unknown = 1, params: unknown = { fields: ['id'], sort: 'id' }, association = 'children') =>
    entry.listAssociationPageFromParams(ctx, mainIdentity, authenticated, { association, sourceKey }, params);
  const loggingOptions = () =>
    (db.sequelize as unknown as { options: { logging: boolean | ((sql: string) => void) } }).options;

  describe('association page entry', () => {
    it('paginates only related readable targets and counts the same roots', async () => {
      expect(await page(1, { fields: ['id'], sort: '-amount', pageSize: 1 })).toEqual({
        rows: [{ id: 104 }],
        count: 3,
        page: 1,
        pageSize: 1,
        totalPage: 3,
      });
      expect(await page(1, { fields: ['id'], sort: '-amount', pageSize: 1, page: 2 })).toMatchObject({
        rows: [{ id: 102 }],
        count: 3,
        page: 2,
      });
      expect(await page(1, { fields: ['id'], filter: { amount: { $gt: 10 } }, sort: 'id' })).toMatchObject({
        rows: [{ id: 102 }, { id: 104 }],
        count: 2,
      });
    });

    it('rejects an unavailable source and preserves genuinely empty lists', async () => {
      for (const key of [3, 999]) await expect(page(key)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await page(5)).toMatchObject({ rows: [], count: 0, totalPage: 0 });
    });

    it('reads V and historical sources without claiming source or target', async () => {
      expect(await page(2)).toMatchObject({ rows: [{ id: 105 }], count: 1 });
      expect(await page(4)).toMatchObject({ rows: [{ id: 107 }], count: 1 });
      expect((await docs.model.findByPk(4))?.getDataValue('tenantId')).toBeNull();
      expect((await children.model.findByPk(107))?.getDataValue('tenantId')).toBeNull();
    });

    it('locates the source by its relationship key even when root details use a business key', async () => {
      docs.options.filterTargetKey = 'name';
      expect(await page('1')).toMatchObject({ rows: [{ id: 101 }, { id: 102 }, { id: 104 }], count: 3 });
      await expect(page('Owned')).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });

    it('keeps shared targets without a tenant column independent of source tenancy', async () => {
      await store.save(
        target,
        { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
        { userId: 28 },
      );
      adapter.release(ctx);
      children.removeField('tenantId');
      await db.sequelize.getQueryInterface().removeColumn(children.model.getTableName(), 'tenant_id');
      await adapter.prepare(ctx, [mainIdentity, target]);
      expect(await page()).toMatchObject({ rows: [{ id: 101 }, { id: 102 }, { id: 103 }, { id: 104 }], count: 4 });
      await expect(page(3)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('intersects final source and target permissions using the original operation path', async () => {
      permissions.set('', { allowed: true, params: { filter: { name: 'Visible' } } });
      await expect(page(1)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      permissions.set('', { allowed: true, params: {} });
      permissions.set('children', { allowed: true, params: { fields: ['name'], filter: { amount: { $gt: 10 } } } });
      expect(await page(1, { fields: ['name'], sort: 'name' })).toMatchObject({
        rows: [{ name: 'Legacy' }, { name: 'Visible' }],
        count: 2,
      });
      const operation = permissionResolver.mock.calls[0][2];
      expect(operation).toMatchObject({ kind: 'list', source: mainIdentity, authenticated });
      expect(operation.context).toBe(ctx);
      expect(permissionResolver.mock.calls.some(([, path]) => path.join('.') === 'children')).toBe(true);
    });

    it('preserves parent nested field restrictions for projection filtering and sorting', async () => {
      permissions.set('', { allowed: true, params: { fields: [], appends: ['children.name'] } });
      expect(await page(1, { fields: ['name'], sort: 'name' })).toMatchObject({
        rows: [{ name: 'Legacy' }, { name: 'Owned' }, { name: 'Visible' }],
        count: 3,
      });
      for (const params of [
        { fields: ['amount'] },
        { fields: ['name'], filter: { amount: 10 } },
        { fields: ['name'], sort: 'amount' },
      ])
        await expect(page(1, params)).rejects.toThrow(/authorized/);
    });

    it('does not grant a denied source association or target operation', async () => {
      for (const [path, permission] of [
        ['', null],
        ['', { allowed: true, params: { fields: ['name'], appends: [] } }],
        ['children', { allowed: false, params: {} }],
      ] as const) {
        permissions.clear();
        permissions.set(path, permission);
        await expect(page()).rejects.toThrow(/authorized/);
      }
    });

    it('expands related targets with independent paths and without exposing pairing keys', async () => {
      expect(await page(1, { fields: ['name'], appends: ['document.name'], sort: 'amount' })).toMatchObject({
        rows: [
          { name: 'Owned', document: { name: 'Owned' } },
          { name: 'Visible', document: { name: 'Owned' } },
          { name: 'Legacy', document: { name: 'Owned' } },
        ],
        count: 3,
      });
      expect(permissionResolver.mock.calls.some(([, path]) => path.join('.') === 'children.document')).toBe(true);
    });

    it('keeps source restrictions on the root list rather than internal role relationship facts', async () => {
      permissions.set('children', {
        allowed: true,
        params: { fields: ['name'], filter: { document: { id: 1 } } },
      });
      expect(await page(1, { fields: ['name'], sort: 'name' })).toMatchObject({ count: 3 });
    });

    it('preserves relation scope and source and target default scopes', async () => {
      docs.setField('visibleChildren', {
        type: 'hasMany',
        target: 'children',
        foreignKey: 'documentId',
        scope: { name: 'Visible' },
      });
      expect(await page(1, { fields: ['id'] }, 'visibleChildren')).toMatchObject({ rows: [{ id: 102 }], count: 1 });
      children.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
      expect(await page()).toMatchObject({ rows: [{ id: 101 }], count: 1 });
      docs.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
      await expect(page()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it.each(['_', null, 1.5, {}, [], ''])('rejects unsupported source key %j', async (key) => {
      await expect(page(key)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });

    it('rejects non-HasMany and forged request capabilities', async () => {
      await expect(page(1, {}, 'child')).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      for (const descriptor of [
        { association: 'children' },
        { association: 'children', sourceKey: 1, where: {} },
        { association: 'children', sourceKey: 1, transaction: {} },
        {
          association: 'children',
          get sourceKey() {
            throw new Error('getter executed');
          },
        },
      ])
        await expect(
          entry.listAssociationPageFromParams(ctx, mainIdentity, authenticated, descriptor, {}),
        ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      await expect(page(1, { fields: ['id'], rootConstraint: {} })).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
    });
  });

  describe('association page lifecycle', () => {
    it('snapshots descriptor params and every permission before querying the source', async () => {
      const descriptor = { association: 'children', sourceKey: 1 };
      const params = { fields: ['name'], appends: ['document.name'], sort: ['name'] };
      const names = ['children.name', 'children.document.name'];
      permissions.set('', { allowed: true, params: { fields: [], appends: names } });
      permissions.set('children', { allowed: true, params: { filter: { amount: { $gt: 10 } } } });
      const original = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        descriptor.sourceKey = 2;
        params.fields[0] = 'id';
        params.appends[0] = 'document.id';
        params.sort[0] = '-name';
        names.splice(0, names.length, 'children.id');
        permissions.set('children.document', null);
        return original(options);
      });
      expect(
        await entry.listAssociationPageFromParams(ctx, mainIdentity, authenticated, descriptor, params),
      ).toMatchObject({
        rows: [
          { name: 'Legacy', document: { name: 'Owned' } },
          { name: 'Visible', document: { name: 'Owned' } },
        ],
        count: 2,
      });
    });

    it('rejects relation changes after source lookup and after target count', async () => {
      const original = docs.model.findOne.bind(docs.model);
      const relation = docs.model.associations.children;
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        const record = await original(options);
        Object.assign(relation, { scope: { name: 'Hidden' } });
        return record;
      });
      await expect(page()).rejects.toThrow(/changed/);
      Object.assign(relation, { scope: undefined });
      const count = children.model.count.bind(children.model);
      vi.spyOn(children.model, 'count').mockImplementationOnce(async (options) => {
        const result = await count(options);
        Object.assign(relation, { scope: { name: 'Hidden' } });
        return result;
      });
      await expect(page()).rejects.toThrow(/changed/);
    });

    it('rejects prepared phase release while the source lookup is pending', async () => {
      const original = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        const record = await original(options);
        adapter.release(ctx);
        return record;
      });
      await expect(page()).rejects.toThrow();
    });

    it('uses the live transaction for source target count and expanded queries', async () => {
      const transaction = await db.sequelize.transaction();
      try {
        await children.model.update({ documentId: 2 }, { where: { id: 101 }, transaction });
        await docs.model.update({ name: 'In transaction', tenantId: 'B' }, { where: { id: 2 }, transaction });
        expect(
          await entry.listAssociationPageFromParams(
            ctx,
            mainIdentity,
            authenticated,
            { association: 'children', sourceKey: 2 },
            { fields: ['id'], appends: ['document.name'], sort: 'id' },
            transaction,
          ),
        ).toMatchObject({
          rows: [
            { id: 101, document: { name: 'In transaction' } },
            { id: 105, document: { name: 'In transaction' } },
          ],
          count: 2,
        });
      } finally {
        await transaction.rollback();
      }
      expect(await page(2)).toMatchObject({ rows: [{ id: 105 }], count: 1 });
      await expect(
        entry.listAssociationPageFromParams(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'children', sourceKey: 1 },
          {},
          transaction,
        ),
      ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    });

    it('resolves trusted date shortcuts using target field metadata', async () => {
      await children.model.update({ occurredAt: '2026-10-15T17:00:00Z' }, { where: { id: 101 } });
      await children.model.update({ occurredAt: '2026-10-16T16:00:00Z' }, { where: { id: 102 } });
      expect(
        await entry.listAssociationPageFromParams(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'children', sourceKey: 1 },
          { fields: ['id'], filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } } },
          undefined,
          { now: '2026-10-16T03:00:00.000Z', timezone: '+08:00' },
        ),
      ).toMatchObject({ rows: [{ id: 101 }], count: 1 });
    });

    it('keeps query counts independent of page length', async () => {
      const messages: string[] = [];
      const logging = loggingOptions().logging;
      loggingOptions().logging = (sql) => messages.push(sql);
      try {
        const params = { fields: ['id'], appends: ['document.name'], pageSize: 100, sort: 'id' };
        await page(1, params);
        const before = messages.length;
        await children.model.bulkCreate(
          Array.from({ length: 40 }, (_, index) => ({
            id: 200 + index,
            documentId: 1,
            tenantId: 'B',
            name: 'Owned',
          })),
        );
        messages.length = 0;
        expect((await page(1, params)).rows).toHaveLength(43);
        expect(messages).toHaveLength(before);
        expect(before).toBeLessThanOrEqual(10);
      } finally {
        loggingOptions().logging = logging;
      }
    });
  });

  it('filters related targets by G or V without claiming legacy data', async () => {
    expect(await ids()).toEqual([101, 102, 104]);
    expect((await children.model.findByPk(104))?.getDataValue('tenantId')).toBeNull();
  });

  it('reads visibility-only and historical sources without changing their ownership', async () => {
    expect(await ids(2)).toEqual([105]);
    expect(await ids(4)).toEqual([107]);
    expect((await docs.model.findByPk(4))?.getDataValue('tenantId')).toBeNull();
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
    const logging = loggingOptions().logging;
    loggingOptions().logging = (sql) => messages.push(sql);
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
      loggingOptions().logging = logging;
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
