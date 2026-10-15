import { ACL, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessEntryReadPermission } from '../../access-control/read-grants';
import { AccessTargetForeignKeyExpansionService } from '../../access-control/target-foreign-key-expansion';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { ...mainIdentity, collectionKey: 'children-key', collectionName: 'children' };
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('target expansion (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let children: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let expansion: AccessTargetForeignKeyExpansionService;
  let entry: AccessEntryReadService;
  let permissions: Map<string, AccessEntryReadPermission | null>;
  let permissionResolver: ReturnType<typeof vi.fn>;
  let ctx: object;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const name of ['documents', 'children']) {
      const collection = db.collection({
        name,
        tableName: `expand_fk_${name}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string' },
          { name: 'secret', type: 'string' },
          { name: 'payload', type: 'json' },
          { name: 'deletedAt', type: 'date', field: 'deleted_at' },
          ...(name === 'children' ? [{ name: 'documentId', type: 'integer', field: 'document_id' }] : []),
        ],
      });
      await collection.model.sync();
    }
    docs = db.getCollection('documents');
    children = db.getCollection('children');
    docs.setField('children', { type: 'hasMany', target: 'children', foreignKey: 'documentId' });
    docs.setField('child', { type: 'hasOne', target: 'children', foreignKey: 'documentId' });
    await docs.repository.create({
      values: [
        { id: 1, tenantId: 'B', name: 'Owned' },
        { id: 2, tenantId: 'H', name: 'Visible' },
        { id: 3, tenantId: 'C', name: 'Hidden' },
        { id: 4, tenantId: null, name: 'Legacy' },
        { id: 5, tenantId: 'B', name: 'Empty' },
        { id: 6, tenantId: 'B', name: 'Owned' },
      ],
    });
    await children.repository.create({
      values: [
        { id: 101, documentId: 1, tenantId: 'B', name: 'Owned', secret: 'secret1' },
        { id: 102, documentId: 1, tenantId: 'H', name: 'Visible', secret: 'secret2' },
        { id: 103, documentId: 1, tenantId: 'C', name: 'Hidden', secret: 'secret3' },
        { id: 104, documentId: 1, tenantId: null, name: 'Legacy', secret: 'secret4' },
        { id: 105, documentId: 2, tenantId: 'B', name: 'Owned', secret: 'secret5' },
        { id: 106, documentId: 3, tenantId: 'B', name: 'Owned', secret: 'secret6' },
        { id: 107, documentId: 4, tenantId: null, name: 'Legacy', secret: 'secret7' },
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
    expansion = new AccessTargetForeignKeyExpansionService(db, adapter, queries);
    permissions = new Map();
    permissionResolver = vi.fn((_collection: Collection, path: readonly string[]) =>
      permissions.has(path.join('.')) ? permissions.get(path.join('.'))! : { allowed: true, params: {} },
    );
    entry = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => ({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name }),
      permissionResolver,
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "expand_fk_children", "expand_fk_documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });

  const load = (sourceKeys: Array<string | number> = [1, 2, 4, 5], extra = {}) =>
    expansion.load(ctx, mainIdentity, target, authenticated, {
      association: 'children',
      sourceKeys,
      targetAttributes: ['name'],
      ...extra,
    });

  const entryLoad = (sourceKeys: Array<string | number> = [1, 2, 4, 5], extra = {}) =>
    entry.expandTargetForeignKey(ctx, mainIdentity, authenticated, {
      association: 'children',
      sourceKeys,
      targetAttributes: ['name'],
      ...extra,
    });

  it('entry expands independently authorized HasMany targets and retains empty sources', async () => {
    permissions.set('', { allowed: true, params: { fields: [], appends: ['children'] } });
    permissions.set('children', { allowed: true, params: { fields: ['name'], filter: { name: { $ne: 'Owned' } } } });
    expect([...(await entryLoad())]).toEqual([
      ['1', [{ name: 'Visible' }, { name: 'Legacy' }]],
      ['2', []],
      ['4', [{ name: 'Legacy' }]],
      ['5', []],
    ]);
    expect(permissionResolver.mock.calls.map(([, path]) => path)).toEqual([[], ['children']]);
  });
  it('entry preserves HasOne cardinality while hiding unauthorized targets', async () => {
    permissions.set('child', { allowed: true, params: { fields: ['name'], filter: { name: 'Owned' } } });
    expect([...(await entryLoad([1, 2, 5], { association: 'child' }))]).toEqual([
      ['1', { name: 'Owned' }],
      ['2', { name: 'Owned' }],
      ['5', null],
    ]);
    permissions.set('child', { allowed: true, params: { fields: ['name'] } });
    await expect(entryLoad([1], { association: 'child' })).rejects.toThrow(/not unique/);
  });
  it.each(['source', 'association', 'target', 'field'])(
    'entry rejects missing %s permission before SQL',
    async (side) => {
      if (side === 'source') permissions.set('', null);
      if (side === 'association') permissions.set('', { allowed: true, params: { fields: ['id'], appends: [] } });
      if (side === 'target') permissions.set('children', { allowed: false, params: {} });
      if (side === 'field') permissions.set('children', { allowed: true, params: { fields: ['id'] } });
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(entryLoad()).rejects.toThrow(/authorized/);
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('entry uses hidden relational facts only for authorization', async () => {
    children.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    permissions.set('children', {
      allowed: true,
      params: { fields: ['name'], filter: { document: { name: 'Visible' } } },
    });
    expect([...(await entryLoad([1, 2]))]).toEqual([
      ['1', []],
      ['2', [{ name: 'Owned' }]],
    ]);
    expect(permissionResolver).toHaveBeenCalledTimes(2);
    permissions.set('', { allowed: true, params: { filter: { children: { name: 'Hidden' } } } });
    permissions.set('children', { allowed: true, params: { fields: ['name'], filter: { name: 'Hidden' } } });
    expect([...(await entryLoad([1]))]).toEqual([['1', []]]);
    await expect(entryLoad([2])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('entry snapshots source and target role permissions and request before awaits', async () => {
    const source = { allowed: true, params: { filter: { name: 'Owned' } } };
    const targetPermission = { allowed: true, params: { fields: ['name'], filter: { name: 'Owned' } } };
    permissions.set('', source);
    permissions.set('children', targetPermission);
    const keys = [1];
    const fields = ['name'];
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      source.params.filter.name = 'Visible';
      targetPermission.params.filter.name = 'Visible';
      keys[0] = 2;
      fields.push('secret');
      return original(...args);
    });
    expect([...(await entryLoad(keys, { targetAttributes: fields }))]).toEqual([['1', [{ name: 'Owned' }]]]);
    expect([...(await entryLoad([2]))]).toEqual([['2', []]]);
  });
  it.each(['source', 'target'])('entry rejects changed role-only metadata after %s SQL', async (side) => {
    children.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    permissions.set('children', { allowed: true, params: { filter: { document: { name: 'Owned' } } } });
    const model = side === 'source' ? docs.model : children.model;
    const original = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      const result = await original(options);
      (children.model.associations.document as unknown as { scope: object }).scope = { name: 'Changed' };
      return result;
    });
    await expect(entryLoad([1])).rejects.toThrow(/changed/);
  });
  it('entry keeps role queries constant for 20 and 100 source rows', async () => {
    children.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    permissions.set('children', {
      allowed: true,
      params: { fields: ['name'], filter: { document: { name: 'Owned' } } },
    });
    const keys = Array.from({ length: 100 }, (_, index) => index + 200);
    await docs.model.bulkCreate(keys.map((id) => ({ id, tenantId: 'B', name: 'Owned' })));
    await children.model.bulkCreate(
      keys.map((id) => ({ id: id + 1000, documentId: id, tenantId: 'B', name: 'Owned' })),
    );
    const query = vi.spyOn(db.sequelize, 'query');
    expect((await entryLoad(keys.slice(0, 20))).size).toBe(20);
    const count = query.mock.calls.length;
    query.mockClear();
    const result = await entryLoad(keys);
    expect(result.size).toBe(100);
    expect([...result.values()]).toEqual(keys.map(() => [{ name: 'Owned' }]));
    expect(query).toHaveBeenCalledTimes(count);
  });
  it('entry reads large authorized JSON without input size limits or exposing pairing keys', async () => {
    const payload = { items: Array.from({ length: 10050 }, (_, index) => index) };
    await children.model.update({ payload }, { where: { id: 105 } });
    permissions.set('children', { allowed: true, params: { fields: ['payload'] } });
    expect([...(await entryLoad([2], { targetAttributes: ['payload'] }))]).toEqual([['2', [{ payload }]]]);
    expect([...(await load([2], { targetAttributes: ['payload'] }))]).toEqual([['2', [{ payload }]]]);
  });
  it.each([{ targetWhere: {} }, { association: 'children.document' }, { sourceKeys: ['_'] }, { sourceKeys: Array(1) }])(
    'entry rejects malformed expansion %# before SQL',
    async (extra) => {
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(entryLoad([1], extra)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('keeps readable roots and batches only readable HasMany targets', async () => {
    expect([...(await load())]).toEqual([
      ['1', [{ name: 'Owned' }, { name: 'Visible' }, { name: 'Legacy' }]],
      ['2', [{ name: 'Owned' }]],
      ['4', [{ name: 'Legacy' }]],
      ['5', []],
    ]);
  });
  it('returns a single readable HasOne target or null', async () => {
    expect([...(await load([2, 5], { association: 'child' }))]).toEqual([
      ['2', { name: 'Owned' }],
      ['5', null],
    ]);
    await children.model.update({ tenantId: 'C' }, { where: { id: 105 } });
    expect([...(await load([2], { association: 'child' }))]).toEqual([['2', null]]);
  });
  it('rejects hidden or missing roots but leaves hidden targets out', async () => {
    for (const keys of [
      [1, 999],
      [1, 3, 6],
    ])
      await expect(load(keys)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect([...(await load([1], { targetWhere: { name: 'Hidden' } }))]).toEqual([['1', []]]);
  });
  it('intersects separate source and target predicates', async () => {
    await expect(load([1, 2], { sourceWhere: { name: 'Owned' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect([...(await load([1], { targetWhere: { id: { [Op.gt]: 102 } } }))]).toEqual([['1', [{ name: 'Legacy' }]]]);
  });
  it('deduplicates source keys and emits only explicitly selected raw fields', async () => {
    expect([...(await load([1, '01', 1], { targetAttributes: ['id', 'name'] }))]).toEqual([
      [
        '1',
        [
          { id: 101, name: 'Owned' },
          { id: 102, name: 'Visible' },
          { id: 104, name: 'Legacy' },
        ],
      ],
    ]);
  });
  it('preserves association scopes and target default scopes', async () => {
    docs.setField('visibleChildren', {
      type: 'hasMany',
      target: 'children',
      foreignKey: 'documentId',
      scope: { name: 'Visible' },
    });
    expect([...(await load([1], { association: 'visibleChildren' }))]).toEqual([['1', [{ name: 'Visible' }]]]);
    children.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
    expect([...(await load([1]))]).toEqual([['1', [{ name: 'Owned' }]]]);
  });
  it('does not claim historical sources or targets', async () => {
    await load([4]);
    expect([...(await entryLoad([4]))]).toEqual([['4', [{ name: 'Legacy' }]]]);
    expect((await docs.model.findByPk(4))!.getDataValue('tenantId')).toBeNull();
    expect((await children.model.findByPk(107))!.getDataValue('tenantId')).toBeNull();
  });
  it('uses constant query count for 20 and 100 sources', async () => {
    await docs.repository.create({
      values: Array.from({ length: 100 }, (_, i) => ({ id: 200 + i, tenantId: 'B', name: 'Owned' })),
    });
    await children.repository.create({
      values: Array.from({ length: 100 }, (_, i) => ({
        id: 300 + i,
        documentId: 200 + i,
        tenantId: 'B',
        name: 'Owned',
      })),
    });
    const messages: string[] = [];
    const runtime = db.sequelize as unknown as { options: { logging: false | ((sql: string) => void) } };
    const logging = runtime.options.logging;
    runtime.options.logging = (sql) => messages.push(sql);
    try {
      expect((await load(Array.from({ length: 20 }, (_, i) => 200 + i))).size).toBe(20);
      const before = messages.length;
      messages.length = 0;
      expect((await load(Array.from({ length: 100 }, (_, i) => 200 + i))).size).toBe(100);
      expect(messages).toHaveLength(before);
      expect(before).toBeLessThanOrEqual(4);
    } finally {
      runtime.options.logging = logging;
    }
  });
  it('rejects HasOne data that violates its single-target contract', async () => {
    await expect(load([1], { association: 'child' })).rejects.toThrow('HasOne target is not unique');
  });
  it('returns an empty map for an empty page and rejects placeholders', async () => {
    expect((await load([])).size).toBe(0);
    await expect(load(['_'])).rejects.toThrow();
  });
  it('ignores unrelated collection metadata changes during a read', async () => {
    const unrelated = db.collection({
      name: 'unrelated',
      timestamps: false,
      fields: [{ name: 'name', type: 'string' }],
    });
    const original = children.model.findAll.bind(children.model);
    vi.spyOn(children.model, 'findAll').mockImplementationOnce(async (options) => {
      const records = await original(options);
      unrelated.model.addScope('defaultScope', { where: { name: 'Changed' } }, { override: true });
      return records;
    });
    expect([...(await load([2]))]).toEqual([['2', [{ name: 'Owned' }]]]);
  });
  it('rejects more than 10000 expanded targets instead of silently truncating', async () => {
    await children.model.bulkCreate(
      Array.from({ length: 10001 }, (_, i) => ({ id: 1000 + i, documentId: 5, tenantId: 'B', name: 'Owned' })),
    );
    await expect(load([5])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('uses the live transaction for both reads', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await children.model.update({ documentId: 5 }, { where: { id: 105 }, transaction });
      expect([...(await load([2, 5], { transaction }))]).toEqual([
        ['2', []],
        ['5', [{ name: 'Owned' }]],
      ]);
      expect([...(await entryLoad([2, 5], { transaction }))]).toEqual([
        ['2', []],
        ['5', [{ name: 'Owned' }]],
      ]);
    } finally {
      await transaction.rollback();
    }
    expect([...(await load([2]))]).toEqual([['2', [{ name: 'Owned' }]]]);
  });
  it('rejects ended or foreign transactions', async () => {
    const ended = await db.sequelize.transaction();
    await ended.rollback();
    await expect(load([2], { transaction: ended })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    await expect(entryLoad([2], { transaction: ended })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    const other = sqliteDatabase();
    const foreign = await other.sequelize.transaction();
    try {
      await expect(load([2], { transaction: foreign })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    } finally {
      await foreign.rollback();
      await other.close();
    }
  });
  it('snapshots keys fields predicates and authenticated identity before awaits', async () => {
    const keys = [2];
    const fields = ['name'];
    const where = { name: 'Owned' };
    const identity = { tenantId: 'B' };
    const pending = expansion.load(ctx, mainIdentity, target, identity, {
      association: 'children',
      sourceKeys: keys,
      targetAttributes: fields,
      targetWhere: where,
    });
    keys[0] = 3;
    fields.push('secret');
    where.name = 'Hidden';
    identity.tenantId = 'C';
    expect([...(await pending)]).toEqual([['2', [{ name: 'Owned' }]]]);
  });
  it('retains source and target soft deletion', async () => {
    for (const model of [docs.model, children.model]) {
      model.options.paranoid = true;
      (model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt =
        'deletedAt';
    }
    await children.model.update({ deletedAt: new Date() }, { where: { id: 105 } });
    expect([...(await load([2]))]).toEqual([['2', []]]);
    await docs.model.update({ deletedAt: new Date() }, { where: { id: 2 } });
    await expect(load([2])).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('ignores custom getters and rejects virtual projection', async () => {
    children.setField('derived', { type: 'virtual', get: () => 'Secret' });
    const getter = vi.fn(() => 'Secret');
    children.model.rawAttributes.name.get = getter;
    (children.model as unknown as { refreshAttributes(): void }).refreshAttributes();
    expect([...(await load([2]))]).toEqual([['2', [{ name: 'Owned' }]]]);
    expect(getter).not.toHaveBeenCalled();
    await expect(load([2], { targetAttributes: ['derived'] })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
  });
  it('does not apply tenant columns to an explicitly shared target', async () => {
    await store.save(
      target,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
      { userId: 28 },
    );
    children.removeField('tenantId');
    await db.sequelize.getQueryInterface().removeColumn(children.model.getTableName(), 'tenant_id');
    adapter.release(ctx);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target]);
    expect(children.model.rawAttributes.tenantId).toBeUndefined();
    expect([...(await load([1]))]).toEqual([
      ['1', [{ name: 'Owned' }, { name: 'Visible' }, { name: 'Hidden' }, { name: 'Legacy' }]],
    ]);
    expect([...(await entryLoad([1]))]).toEqual([
      ['1', [{ name: 'Owned' }, { name: 'Visible' }, { name: 'Hidden' }, { name: 'Legacy' }]],
    ]);
  });
  it.each(['source', 'target'])('rejects metadata changes after the %s read', async (side) => {
    const model = side === 'source' ? docs.model : children.model;
    const original = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      const result = await original(options);
      model.rawAttributes.name.field = 'secret';
      return result;
    });
    await expect(load([2])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('rejects association replacement while reading', async () => {
    const original = children.model.findAll.bind(children.model);
    vi.spyOn(children.model, 'findAll').mockImplementationOnce(async (options) => {
      const result = await original(options);
      docs.setField('children', { type: 'hasMany', target: 'children', foreignKey: 'documentId' });
      return result;
    });
    await expect(load([2])).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('rejects a result after its configuration phase ends', async () => {
    const original = children.model.findAll.bind(children.model);
    vi.spyOn(children.model, 'findAll').mockImplementationOnce(async (options) => {
      const result = await original(options);
      adapter.release(ctx);
      return result;
    });
    await expect(load([2])).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });
  it('rejects missing tenant context even for empty pages', async () => {
    await expect(
      expansion.load(
        ctx,
        mainIdentity,
        target,
        {},
        { association: 'children', sourceKeys: [], targetAttributes: ['name'] },
      ),
    ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });
  it('rejects wrong and unprepared identities', async () => {
    for (const identity of [mainIdentity, { ...target, collectionKey: 'wrong' }, { ...target, dataSourceKey: 'other' }])
      await expect(
        expansion.load(ctx, mainIdentity, identity, authenticated, {
          association: 'children',
          sourceKeys: [2],
          targetAttributes: ['name'],
        }),
      ).rejects.toThrow();
  });
  it.each([
    { sourceKeys: [1.5] },
    { sourceKeys: Array(1) },
    { sourceKeys: Array(1001).fill(2) },
    { targetAttributes: ['missing'] },
    { targetAttributes: [] },
    { targetAttributes: [['name', 'alias']] },
    { targetAttributes: Array(1) },
    { targetBind: [1] },
    { include: ['children'] },
    { limit: 1 },
    { association: 'missing' },
    { association: 'toString' },
    { association: null },
  ])('rejects unsupported expansion input %#', async (extra) => {
    await expect(load([2], extra)).rejects.toThrow();
  });
  it('does not invoke input accessors', async () => {
    const getter = vi.fn(() => 'secret');
    const request = {
      association: 'children',
      sourceKeys: [2],
      targetAttributes: ['name'],
      targetWhere: Object.defineProperty({}, 'name', { enumerable: true, get: getter }),
    };
    await expect(expansion.load(ctx, mainIdentity, target, authenticated, request)).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(getter).not.toHaveBeenCalled();
  });
});
