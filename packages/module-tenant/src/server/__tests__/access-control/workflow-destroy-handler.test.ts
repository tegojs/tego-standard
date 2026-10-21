import { ACL, Transaction, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessQueryService } from '../../access-control/query';
import { AccessWorkflowDestroyHandler } from '../../access-control/workflow-destroy-handler';
import { seedAclScopes } from './acl-database';
import { configStore, mainIdentity, seedConfigStore } from './config-database';
import { sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

describe('workflow ownership-authorized root deletion', () => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let ctx: object;
  let permission;
  let resolvedIdentity;
  let actor;
  let handler: AccessWorkflowDestroyHandler;
  let authorize;

  beforeEach(async () => {
    db = sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({
      name: 'documents',
      tableName: 'access_documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer' },
      ],
    });
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await docs.model.sync();
    await tenants.model.sync();
    await docs.model.bulkCreate([
      { id: 1, name: 'Visible', tenantId: 'H', amount: 10 },
      { id: 3, name: 'Owned', tenantId: 'B', amount: 30 },
      { id: 4, name: 'Other', tenantId: 'C', amount: 40 },
      { id: 5, name: 'Legacy', tenantId: null, amount: 50 },
      { id: 7, name: 'Second', tenantId: 'B', amount: 70 },
    ]);
    await tenants.model.bulkCreate(['B', 'C', 'H'].map((id) => ({ id, enabled: true })));
    const store = configStore(db);
    const config = configFor(ownerCondition);
    config.rules.push({ ...configFor({ type: 'constant', value: true }, 'visibility').rules[0], id: 'visible' });
    await store.save(mainIdentity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    resolvedIdentity = { ...mainIdentity };
    const identity = () => resolvedIdentity;
    queries = new AccessQueryService(db, adapter, () => accessCollectionKey(resolvedIdentity));
    permission = { source: { ...mainIdentity }, actionName: 'destroy', allowed: true, params: {} };
    actor = { tenantId: 'B' };
    authorize = (_collection, operation) => {
      expect(operation.kind).toBe('destroy');
      expect(operation.source).toEqual(mainIdentity);
      expect(operation.authenticated).toEqual({ tenantId: 'B' });
      return permission;
    };
    handler = new AccessWorkflowDestroyHandler(db, adapter, queries, identity, (collection, operation) =>
      authorize(collection, operation),
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  const request = (transaction: Transaction, params: unknown) => ({
    dataSourceName: 'main',
    collectionName: 'documents',
    collection: docs,
    context: ctx,
    params,
    transaction,
  });
  const execute = (params: unknown = { filterByTk: 3 }, mutate = (_request) => {}) =>
    db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async (transaction) => {
      const input = request(transaction, params);
      mutate(input);
      return handler.handle(input, actor);
    });
  const ids = async () => (await docs.model.findAll({ order: [['id', 'ASC']] })).map((record) => record.get('id'));

  it('deletes an explicitly selected owned record with trusted tenant-only automatic identity', async () => {
    expect(await execute()).toBe(1);
    expect(await ids()).toEqual([1, 4, 5, 7]);
  });

  it('intersects filtered deletion with ownership and finalized destroy scope without requiring list permission', async () => {
    permission.params = { filter: { amount: { $lt: 60 } } };
    expect(await execute({ filter: { amount: { $gt: 20 } } })).toBe(1);
    expect(await ids()).toEqual([1, 4, 5, 7]);
  });

  it('deletes all matching owned roots and returns only their count', async () => {
    expect(await execute({ filter: {} })).toBe(2);
    expect(await ids()).toEqual([1, 4, 5]);
  });

  it('returns zero for an empty authorized filtered selection', async () => {
    expect(await execute({ filter: { id: 999 } })).toBe(0);
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it.each([1, 4, 999, [3, 1], [3, 999]])('rejects an unavailable explicit selection atomically: %j', async (key) => {
    await expect(execute({ filterByTk: key })).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it('applies the finalized scope and request filter even for explicit keys', async () => {
    permission.params = { filter: { amount: { $gt: 50 } } };
    await expect(execute()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    permission.params = {};
    await expect(execute({ filterByTk: 3, filter: { name: 'Other' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it('does not delete unassigned visible legacy data', async () => {
    await expect(execute({ filterByTk: 5 })).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it.each(['missing', 'denied', 'list', 'other-source', 'other-key'])(
    'rejects an invalid final destroy grant even when the filter matches nothing: %s',
    async (mode) => {
      if (mode === 'missing') permission = null;
      if (mode === 'denied') permission.allowed = false;
      if (mode === 'list') permission.actionName = 'list';
      if (mode === 'other-source') permission.source.dataSourceKey = 'external';
      if (mode === 'other-key') permission.source.collectionKey = 'replacement';
      await expect(execute({ filter: { id: 999 } })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await ids()).toEqual([1, 3, 4, 5, 7]);
    },
  );

  it.each(['external', 'different-collection', 'no-context', 'no-transaction'])(
    'binds the request to the actual database target and transaction: %s',
    async (mode) => {
      await expect(
        execute(undefined, (input) => {
          if (mode === 'external') input.dataSourceName = 'external';
          if (mode === 'different-collection') input.collection = db.getCollection('tenants');
          if (mode === 'no-context') input.context = undefined;
          if (mode === 'no-transaction') input.transaction = undefined;
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await ids()).toEqual([1, 3, 4, 5, 7]);
    },
  );

  it.each([{ limit: 1 }, { values: {} }, { context: {} }, { transaction: {} }, { hooks: false }, { sort: ['id'] }])(
    'rejects unsupported node controls instead of ignoring them: %j',
    async (extra) => {
      await expect(execute({ filter: {}, ...extra })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await ids()).toEqual([1, 3, 4, 5, 7]);
    },
  );

  it('captures node parameters and authenticated identity before authorization callbacks', async () => {
    const params = { filterByTk: 3 };
    authorize = () => {
      params.filterByTk = 4;
      actor.tenantId = 'C';
      return permission;
    };
    expect(await execute(params)).toBe(1);
    expect(await ids()).toEqual([1, 4, 5, 7]);
  });

  it('never invokes accessors in node parameters', async () => {
    let evaluated = false;
    const params = Object.defineProperty({}, 'filterByTk', {
      get() {
        evaluated = true;
        return 3;
      },
    });
    await expect(execute(params)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(evaluated).toBe(false);
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it.each(['permission', 'phase', 'identity'])(
    'rolls back deletion when %s changes during a repository hook',
    async (change) => {
      db.on('documents.afterDestroy', async () => {
        if (change === 'permission') permission.allowed = false;
        if (change === 'phase') adapter.release(ctx);
        if (change === 'identity') resolvedIdentity = { ...mainIdentity, collectionKey: 'replacement' };
      });
      await expect(execute()).rejects.toBeInstanceOf(Error);
      expect(await ids()).toEqual([1, 3, 4, 5, 7]);
    },
  );

  it('rolls back every selected root when a later repository hook throws', async () => {
    const error = new Error('business hook rejected deletion');
    db.on('documents.afterDestroy', async (record) => {
      if (record.get('id') === 7) throw error;
    });
    await expect(execute({ filter: {} })).rejects.toBe(error);
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it('does not commit an inherited transaction after successful deletion', async () => {
    const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
    try {
      expect(await handler.handle(request(transaction, { filterByTk: 3 }), actor)).toBe(1);
      expect(await docs.model.findByPk(3, { transaction })).toBeNull();
    } finally {
      await transaction.rollback();
    }
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it('rejects insufficient inherited isolation instead of opening a replacement transaction', async () => {
    const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.DEFERRED });
    try {
      await expect(handler.handle(request(transaction, { filter: {} }), actor)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
      expect(await docs.model.count({ transaction })).toBe(5);
    } finally {
      await transaction.rollback();
    }
  });

  it('rejects more than 1000 matching roots before deleting any of them', async () => {
    await docs.model.bulkCreate(
      Array.from({ length: 999 }, (_, i) => ({ id: i + 10, name: 'Bulk', amount: 1, tenantId: 'B' })),
    );
    await expect(execute({ filter: {} })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await docs.model.count()).toBe(1004);
  });

  it.each([
    { keys: [] },
    { keys: Object.assign([], { length: 3, 0: 3, 2: 7 }) },
    { keys: Object.assign([3], { extra: 7 }) },
    { keys: Object.setPrototypeOf([3], null) },
  ])('rejects malformed explicit key arrays before any write: %j', async ({ keys }) => {
    await expect(execute({ filterByTk: keys })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it('rejects accessors inside a key list without evaluating them', async () => {
    let evaluated = false;
    const keys = Object.defineProperty([3], '0', {
      get() {
        evaluated = true;
        return 3;
      },
    });
    await expect(execute({ filterByTk: keys })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(evaluated).toBe(false);
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it.each(['phase', 'permission'])(
    'rejects %s changes during an empty selection instead of publishing zero',
    async (change) => {
      const original = queries.scopeQuery.bind(queries);
      vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        if (change === 'phase') adapter.release(ctx);
        else permission.params = { filter: { amount: { $gt: 50 } } };
        return result;
      });
      await expect(execute({ filter: { id: 999 } })).rejects.toMatchObject({
        code: change === 'phase' ? 'INVALID_ACCESS_CONFIG_WRITE' : 'INVALID_ACCESS_MUTATION',
      });
      expect(await ids()).toEqual([1, 3, 4, 5, 7]);
    },
  );

  it('rolls back a successful deletion when the final permission filter changes', async () => {
    db.on('documents.afterDestroy', () => {
      permission.params = { filter: { amount: { $gt: 50 } } };
    });
    await expect(execute()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it.each(['own', 'unknown', 'variable'])(
    'rejects unresolved or unsupported final permission controls: %s',
    async (mode) => {
      permission.params =
        mode === 'own' ? { own: true } : mode === 'unknown' ? { limit: 1 } : { filter: { id: '{{$user.id}}' } };
      await expect(execute({ filter: {} })).rejects.toBeInstanceOf(Error);
      expect(await ids()).toEqual([1, 3, 4, 5, 7]);
    },
  );

  it.each(['node', 'role'])(
    'does not treat relational %s conditions as ordinary scalar deletion conditions',
    async (mode) => {
      docs.setField('tenant', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId', onDelete: 'RESTRICT' });
      handler = new AccessWorkflowDestroyHandler(
        db,
        adapter,
        queries,
        (collection) =>
          collection === docs
            ? resolvedIdentity
            : { ...mainIdentity, collectionName: 'tenants', collectionKey: 'tenants-key' },
        () => permission,
      );
      const relational = { tenant: { id: 'B' } };
      if (mode === 'role') permission.params = { filter: relational };
      await expect(execute({ filter: mode === 'node' ? relational : {} })).rejects.toMatchObject({
        code: mode === 'node' ? 'INVALID_ACCESS_MUTATION' : 'UNSUPPORTED_ACCESS_MUTATION',
      });
      expect(await ids()).toEqual([1, 3, 4, 5, 7]);
    },
  );

  it('requires the trusted tenant when the configured ownership rule needs it', async () => {
    actor = {};
    authorize = () => permission;
    await expect(execute({ filter: {} })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    expect(await ids()).toEqual([1, 3, 4, 5, 7]);
  });

  it.each(['node', 'role'])(
    'rejects a malformed filter list in %s input before copying can normalize its prototype',
    async (mode) => {
      const filter = { id: { $in: Object.setPrototypeOf([3], null) } };
      if (mode === 'role') permission.params = { filter };
      await expect(execute({ filter: mode === 'node' ? filter : {} })).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
      expect(await ids()).toEqual([1, 3, 4, 5, 7]);
    },
  );

  it('accepts exactly 1000 matching roots without silently truncating the count', async () => {
    await docs.model.bulkCreate(
      Array.from({ length: 998 }, (_, i) => ({ id: i + 10, name: 'Bulk', amount: 1, tenantId: 'B' })),
    );
    expect(await execute({ filter: {} })).toBe(1000);
    expect(await ids()).toEqual([1, 4, 5]);
  }, 20000);
});
