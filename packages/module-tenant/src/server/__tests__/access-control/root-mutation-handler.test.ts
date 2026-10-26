import { ACL, Resourcer, Transaction, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootMutationHandler } from '../../access-control/root-mutation-handler';
import type { AccessConfig } from '../../access-control/types';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('finalized root mutations (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let handler: AccessRootMutationHandler;
  const auth = () => ({ tenantId: 'B', roleName: 'editor', userId: 28 });
  const identity = (collection: Collection) =>
    collection === docs ? mainIdentity : { ...mainIdentity, collectionKey: 'tenants-key', collectionName: 'tenants' };

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({
      name: 'documents',
      tableName: 'mutation_handler_documents',
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
      tableName: 'mutation_handler_tenants',
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
      { id: 1, tenantId: 'H', name: 'Visible', amount: 10 },
      { id: 3, tenantId: 'B', name: 'Owned', amount: 30 },
      { id: 4, tenantId: 'C', name: 'Hidden', amount: 40 },
      { id: 5, tenantId: null, name: 'Legacy', amount: 50 },
    ]);
    await tenants.model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor({ type: 'constant', value: true }, 'visibility').rules[0],
      id: 'visible',
    });
    await store.save(mainIdentity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    handler = new AccessRootMutationHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres') await db.sequelize.drop({ cascade: true });
    } finally {
      await db.close();
    }
  });

  async function context(operation = 'update', params: Record<string, unknown> = {}, permission: object = {}) {
    const acl = new ACL();
    acl.setAvailableAction('update', {});
    acl.setAvailableAction('destroy', {});
    acl.setAvailableAction('list', {});
    acl.define({ role: 'editor' }).grantAction(`documents:${operation}`, permission);
    const resourcer = new Resourcer();
    resourcer.define({ name: 'documents', actions: { update: {}, destroy: {}, list: {} } });
    const action = resourcer.getAction('documents', operation).clone();
    Object.assign(action, {
      resourceName: 'documents',
      actionName: operation,
      sourceId: undefined,
      resourceOf: undefined,
    });
    action.mergeParams({
      resourceName: 'documents',
      actionName: operation,
      filterByTk: operation === 'list' ? undefined : 3,
      ...params,
    });
    const result = {
      db,
      action,
      state: { currentRole: 'editor', currentUser: { id: 28, name: 'Owned' } },
      get: () => '+08:00',
      logger: { info: vi.fn() },
      throw: (status: number) => {
        throw new Error(String(status));
      },
      permission: undefined as unknown,
      body: 'unchanged' as unknown,
    };
    await adapter.prepare(result, [mainIdentity]);
    await acl.middleware()(result as never, async () => {});
    return result;
  }

  async function configure(config: AccessConfig) {
    const previous = await store.read(mainIdentity);
    if (!previous) throw new Error('Expected an existing access configuration');
    await store.save(mainIdentity, { ...config, revision: previous.revision }, { userId: 28 });
  }

  const read = async (id = 3) => (await docs.model.findByPk(id))?.get();

  it('updates using final field grants and returns only a minimal committed result', async () => {
    const ctx = await context('update', { values: { name: 'Changed', amount: 999 } }, { fields: ['name'] });
    await handler.handle(ctx, auth());
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    expect(await read()).toMatchObject({ name: 'Changed', amount: 30, tenantId: 'B' });
  });

  it('destroys owned records under the actual destroy operation permission', async () => {
    const ctx = await context('destroy');
    await handler.handle(ctx, auth());
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    expect(await read()).toBeUndefined();
  });

  it.each(['update', 'destroy'])('selects only matching writable records for a filter-only %s', async (operation) => {
    await docs.model.bulkCreate([
      { id: 7, tenantId: 'B', name: 'Owned', amount: 70 },
      { id: 8, tenantId: 'B', name: 'Owned', amount: 80 },
      { id: 9, tenantId: 'B', name: 'Other', amount: 90 },
    ]);
    const ctx = await context(
      operation,
      {
        filterByTk: undefined,
        filter: { amount: { $gte: 10 } },
        ...(operation === 'update' ? { values: { name: 'Changed', amount: 999 } } : {}),
      },
      { fields: ['name'], filter: { amount: { $lte: 70 } } },
    );
    await handler.handle(ctx, auth(), () => context('list', {}, { filter: { name: 'Owned' } }));
    expect(ctx.body).toEqual({ keys: [3, 7], affected: 2 });
    if (operation === 'update') {
      expect(await read()).toMatchObject({ name: 'Changed', amount: 30, tenantId: 'B' });
      expect(await read(7)).toMatchObject({ name: 'Changed', amount: 70, tenantId: 'B' });
    } else {
      expect(await read()).toBeUndefined();
      expect(await read(7)).toBeUndefined();
    }
    expect(await read(1)).toMatchObject({ name: 'Visible', tenantId: 'H' });
    expect(await read(4)).toMatchObject({ name: 'Hidden', tenantId: 'C' });
    expect(await read(5)).toMatchObject({ name: 'Legacy', tenantId: null });
    expect(await read(8)).toMatchObject({ name: 'Owned', amount: 80 });
    expect(await read(9)).toMatchObject({ name: 'Other', amount: 90 });
  });

  describe('filter-only scalar mutations', () => {
    const matching = (operation = 'update', filter: object = { name: 'Owned' }, permission: object = {}) =>
      context(
        operation,
        {
          filterByTk: undefined,
          filter,
          ...(operation === 'update' ? { values: { name: 'Changed' } } : {}),
        },
        permission,
      );

    it.each(['update', 'destroy'])('returns an empty committed result for a nonmatching %s', async (operation) => {
      const ctx = await matching(operation, { name: 'Missing' });
      await handler.handle(ctx, auth(), () => context('list'));
      expect(ctx.body).toEqual({ keys: [], affected: 0 });
      expect(await docs.model.count()).toBe(4);
      expect(await read()).toMatchObject({ name: 'Owned' });
    });

    it.each([{ name: 'Visible' }, { name: 'Legacy' }, { $or: [] }])(
      'does not promote readable or false matches into writable selections: %j',
      async (filter) => {
        const ctx = await matching('update', filter);
        await handler.handle(ctx, auth(), () => context('list'));
        expect(ctx.body).toEqual({ keys: [], affected: 0 });
        expect(await read(1)).toMatchObject({ name: 'Visible', tenantId: 'H' });
        expect(await read(5)).toMatchObject({ name: 'Legacy', tenantId: null });
      },
    );

    it('applies G even when a nonempty logical filter matches all records', async () => {
      const ctx = await matching('update', { $or: [{}] });
      await handler.handle(ctx, auth(), () => context('list'));
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
      expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B' });
      expect(await read(4)).toMatchObject({ name: 'Hidden', tenantId: 'C' });
    });

    it.each(['update', 'destroy'])(
      'checks %s permission fields and conditions even when no rows match',
      async (operation) => {
        const ctx = await matching(operation, { name: 'Missing' });
        (ctx.permission as { parsedParams: object }).parsedParams = { own: true };
        await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toThrow();
        expect(ctx.body).toBe('unchanged');
        expect(await docs.model.count()).toBe(4);
      },
    );

    it.each(['field', 'denied', 'wrong-role', 'scoped-request'])(
      'rejects an invalid %s read decision',
      async (kind) => {
        const ctx = await matching();
        await expect(
          handler.handle(ctx, auth(), async () => {
            if (kind === 'denied') return null;
            const decision = await context(
              'list',
              kind === 'scoped-request' ? { filter: { id: 3 } } : {},
              kind === 'field' ? { fields: ['id'] } : {},
            );
            if (kind === 'wrong-role')
              Object.assign(decision.permission as object, {
                can: { resource: 'documents', action: 'list', role: 'another-role' },
              });
            return decision;
          }),
        ).rejects.toThrow();
        expect(ctx.body).toBe('unchanged');
        expect(await read()).toMatchObject({ name: 'Owned' });
      },
    );

    it.each([undefined, {}, null, []])('rejects missing or empty selection conditions %j', async (filter) => {
      const ctx = await matching();
      (ctx.permission as { rawParams: { filter: unknown } }).rawParams.filter = filter;
      await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toThrow();
      expect(ctx.body).toBe('unchanged');
      expect(await read()).toMatchObject({ name: 'Owned' });
    });

    it.each([null, [], '', '_'])(
      'does not turn an invalid explicit key %j into a matching selection',
      async (filterByTk) => {
        const ctx = await matching();
        (ctx.permission as { rawParams: { filterByTk: unknown } }).rawParams.filterByTk = filterByTk;
        await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toThrow();
        expect(ctx.body).toBe('unchanged');
        expect(await read()).toMatchObject({ name: 'Owned' });
      },
    );

    it('captures filter, values and identity before asynchronous read authorization', async () => {
      const ctx = await matching();
      const actor = auth();
      await handler.handle(ctx, actor, async () => {
        Object.assign((ctx.permission as { rawParams: object }).rawParams, {
          filter: { name: 'Hidden' },
          values: { name: 'Injected' },
        });
        actor.tenantId = 'C';
        return context('list');
      });
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
      expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B' });
      expect(await read(4)).toMatchObject({ name: 'Hidden' });
    });

    it.each(['update', 'destroy'])(
      'rolls back every selected %s after a late repository failure',
      async (operation) => {
        await docs.model.create({ id: 7, tenantId: 'B', name: 'Owned', amount: 70 });
        const ctx = await matching(operation);
        let observed = false;
        db.on(`documents.${operation === 'update' ? 'afterUpdate' : 'afterDestroy'}`, async (record, options) => {
          if (record.get('id') !== 7) return;
          const first = await docs.model.findByPk(3, { transaction: options.transaction });
          if (operation === 'update') expect(first?.get('name')).toBe('Changed');
          else expect(first).toBeNull();
          observed = true;
          throw new Error('Late matching failure');
        });
        await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toThrow('Late matching failure');
        expect(observed).toBe(true);
        expect(await read()).toMatchObject({ name: 'Owned' });
        expect(await read(7)).toMatchObject({ name: 'Owned' });
        expect(ctx.body).toBe('unchanged');
      },
    );

    it.each(['empty', 'matched'])('rejects phase changes after the %s selection query', async (selection) => {
      const ctx = await matching('update', { name: selection === 'empty' ? 'Missing' : 'Owned' });
      const original = docs.model.findAll;
      vi.spyOn(docs.model, 'findAll').mockImplementation(async function (this: typeof docs.model, ...args) {
        const rows = await original.apply(this, args);
        adapter.release(ctx);
        return rows;
      });
      await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toThrow(/phase|prepared/);
      expect(ctx.body).toBe('unchanged');
      expect(await read()).toMatchObject({ name: 'Owned' });
    });

    it('claims a selected editable legacy record without changing referenced or unmatched records', async () => {
      await configure(configFor({ type: 'constant', value: true }));
      const ctx = await matching('update', { name: 'Legacy' });
      await handler.handle(ctx, auth(), () => context('list'));
      expect(ctx.body).toEqual({ keys: [5], affected: 1 });
      expect(await read(5)).toMatchObject({ name: 'Changed', tenantId: 'B' });
      expect(await read()).toMatchObject({ name: 'Owned', tenantId: 'B' });
    });

    it('rejects direct legacy deletion atomically even when G includes legacy records', async () => {
      await configure(configFor({ type: 'constant', value: true }));
      const ctx = await matching('destroy', { id: { $in: [3, 5] } });
      await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toMatchObject({
        code: 'LEGACY_DATA_READ_ONLY',
      });
      expect(await read()).toMatchObject({ name: 'Owned' });
      expect(await read(5)).toMatchObject({ name: 'Legacy', tenantId: null });
      expect(ctx.body).toBe('unchanged');
    });

    it('does not bypass cascade validation for an empty matching destroy', async () => {
      const children = db.collection({
        name: 'cascade_children',
        timestamps: false,
        fields: [
          { name: 'document', type: 'belongsTo', target: 'documents', foreignKey: 'documentId', onDelete: 'CASCADE' },
        ],
      });
      await children.model.sync();
      const ctx = await matching('destroy', { name: 'Missing' });
      await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toMatchObject({
        code: 'UNSUPPORTED_ACCESS_MUTATION',
      });
      expect(ctx.body).toBe('unchanged');
      expect(await docs.model.count()).toBe(4);
    });

    it.each(['context', 'constant'])('requires a valid active tenant for an empty match with %s G', async (rule) => {
      if (rule === 'constant') await configure(configFor({ type: 'constant', value: true }));
      const ctx = await matching('update', { name: 'Missing' });
      await db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'B' } });
      await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toThrow();
      expect(ctx.body).toBe('unchanged');
      expect(await read()).toMatchObject({ name: 'Owned' });
    });

    it('rejects ownership transfers in a nonempty selection before writing', async () => {
      const ctx = await matching();
      (ctx.permission as { rawParams: { values: unknown } }).rawParams.values = { name: 'Forbidden', tenantId: 'C' };
      await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toMatchObject({
        code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN',
      });
      expect(await read()).toMatchObject({ name: 'Owned', tenantId: 'B' });
      expect(ctx.body).toBe('unchanged');
    });

    it('rejects more than 1000 matches before changing any record', async () => {
      await docs.model.bulkCreate(
        Array.from({ length: 1000 }, (_, index) => ({
          id: index + 10,
          tenantId: 'B',
          name: 'Owned',
          amount: 10,
        })),
      );
      const ctx = await matching();
      await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toThrow(/1000/);
      expect(await docs.model.count({ where: { name: 'Owned' } })).toBe(1001);
      expect(ctx.body).toBe('unchanged');
    });

    it.each(['empty', 'matched'])('retains relational read scope isolation for a %s selection', async (selection) => {
      docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
      const ctx = await matching('update', { name: selection === 'empty' ? 'Missing' : 'Owned' });
      let isolation: string | undefined;
      db.on('documents.afterUpdate', (_record, options) => {
        isolation = options.transaction.options.isolationLevel;
      });
      const result = handler.handle(ctx, auth(), () =>
        context('list', {}, { fields: ['name'], filter: { owner: { enabled: true } } }),
      );
      if (dialect === 'sqlite') {
        await expect(result).rejects.toThrow(/PostgreSQL/);
        expect(ctx.body).toBe('unchanged');
      } else {
        await result;
        expect(ctx.body).toEqual(selection === 'empty' ? { keys: [], affected: 0 } : { keys: [3], affected: 1 });
        if (selection === 'matched') expect(isolation).toBe(Transaction.ISOLATION_LEVELS.SERIALIZABLE);
      }
      expect(await read()).toMatchObject({
        name: dialect === 'postgres' && selection === 'matched' ? 'Changed' : 'Owned',
      });
    });

    it('allows exactly 1000 matching records with ordered per-record repository hooks', async () => {
      await docs.model.bulkCreate(
        Array.from({ length: 999 }, (_, index) => ({
          id: index + 10,
          tenantId: 'B',
          name: 'Owned',
          amount: 10,
        })),
      );
      const observed: number[] = [];
      db.on('documents.afterDestroy', (record) => {
        observed.push(record.get('id'));
      });
      const ctx = await matching('destroy');
      await handler.handle(ctx, auth(), () => context('list'));
      expect(ctx.body).toMatchObject({ affected: 1000 });
      expect(observed).toHaveLength(1000);
      expect(observed.slice(0, 3)).toEqual([3, 10, 11]);
      expect(observed.at(-1)).toBe(1008);
      expect(await docs.model.count()).toBe(3);
    }, 60_000);
  });

  it.each(['update', 'destroy'])('accepts an explicit empty request filter for keyed %s', async (operation) => {
    const ctx = await context(
      operation,
      { filter: {}, ...(operation === 'update' ? { values: { name: 'Changed', amount: 999 } } : {}) },
      { fields: ['name'], filter: { name: 'Owned' } },
    );
    await handler.handle(ctx, auth());
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    if (operation === 'update') expect(await read()).toMatchObject({ name: 'Changed', amount: 30, tenantId: 'B' });
    else expect(await read()).toBeUndefined();
    expect((ctx.permission as { rawParams: object }).rawParams).toHaveProperty('filter', {});
  });

  it.each(['nonempty', 'array', 'null', 'string', 'date', 'prototype', 'symbol', 'accessor'])(
    'rejects a %s request filter before SQL without evaluating it',
    async (kind) => {
      const getter = vi.fn(() => 'Owned');
      const filters: Record<string, unknown> = {
        nonempty: { name: 'Owned' },
        array: [],
        null: null,
        string: '{}',
        date: new Date(),
        prototype: Object.create({ name: 'Owned' }),
        symbol: { [Symbol('condition')]: true },
        accessor: Object.defineProperty({}, 'name', { get: getter }),
      };
      for (const operation of ['update', 'destroy']) {
        const ctx = await context(operation, operation === 'update' ? { values: { name: 'Bad' } } : {});
        (ctx.permission as { rawParams: { filter?: unknown } }).rawParams.filter = filters[kind];
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(sql).not.toHaveBeenCalled();
        expect(getter).not.toHaveBeenCalled();
        expect(ctx.body).toBe('unchanged');
        sql.mockRestore();
        expect(await read()).toMatchObject({ name: 'Owned', tenantId: 'B' });
      }
    },
  );

  it.each(['update', 'destroy'])(
    'intersects a keyed %s request filter with final read and write scopes',
    async (operation) => {
      const ctx = await context(
        operation,
        {
          filter: { $and: [{ name: { $startsWith: 'Own' } }, { amount: { $gte: 30 } }] },
          ...(operation === 'update' ? { values: { name: 'Changed', amount: 99 } } : {}),
        },
        { fields: ['name'], filter: { amount: { $lte: 30 } } },
      );
      await handler.handle(ctx, auth(), () =>
        context('list', {}, { fields: ['name', 'amount'], filter: { name: 'Owned' } }),
      );
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
      if (operation === 'update') expect(await read()).toMatchObject({ name: 'Changed', amount: 30, tenantId: 'B' });
      else expect(await read()).toBeUndefined();
    },
  );

  it.each([
    'request',
    'read',
    'write',
    'ownership',
    'field',
    'read-denied',
    'read-filtered',
    'read-role',
    'read-action',
    'association',
  ])('rejects a keyed filtered mutation outside its %s boundary without writing', async (boundary) => {
    if (boundary === 'association')
      docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
    const ctx = await context(
      'update',
      {
        filterByTk: boundary === 'ownership' ? 1 : 3,
        filter:
          boundary === 'association'
            ? { owner: { id: 'B' } }
            : { name: boundary === 'ownership' ? 'Visible' : boundary === 'request' ? 'Other' : 'Owned' },
        values: { name: 'Forbidden' },
      },
      boundary === 'write' ? { filter: { amount: { $lt: 30 } } } : {},
    );
    await expect(
      handler.handle(ctx, auth(), async () => {
        if (boundary === 'read-denied') return null;
        const decision = await context('list', boundary === 'read-filtered' ? { filter: { id: 3 } } : {}, {
          fields: boundary === 'field' ? ['id'] : undefined,
          ...(boundary === 'read' ? { filter: { amount: { $lt: 30 } } } : {}),
        });
        if (boundary === 'read-role')
          Object.assign(decision.permission as object, {
            can: { resource: 'documents', action: 'list', role: 'another-role' },
          });
        if (boundary === 'read-action') Object.assign(decision.action, { actionName: 'get' });
        return decision;
      }),
    ).rejects.toThrow();
    expect(ctx.body).toBe('unchanged');
    expect(await read()).toMatchObject({ name: 'Owned', amount: 30, tenantId: 'B' });
    expect(await read(1)).toMatchObject({ name: 'Visible', tenantId: 'H' });
  });

  it('rejects the whole explicit key selection when one key misses the request filter', async () => {
    await docs.model.create({ id: 7, tenantId: 'B', name: 'Other', amount: 70 });
    const ctx = await context('update', {
      filterByTk: [3, 7],
      filter: { name: 'Owned' },
      values: { name: 'Forbidden' },
    });
    await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toThrow();
    expect(await read()).toMatchObject({ name: 'Owned' });
    expect(await read(7)).toMatchObject({ name: 'Other' });
    expect(ctx.body).toBe('unchanged');
  });

  it('keeps the original filter, values and actor while awaiting the read decision', async () => {
    const ctx = await context('update', { filter: { name: 'Owned' }, values: { name: 'Changed' } });
    const actor = auth();
    await handler.handle(ctx, actor, async () => {
      Object.assign((ctx.permission as { rawParams: object }).rawParams, {
        filter: { name: 'Other' },
        values: { name: 'Injected' },
      });
      actor.tenantId = 'C';
      return context('list', {}, { filter: { name: 'Owned' } });
    });
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B' });
  });

  it('treats request strings containing template markers as literal values', async () => {
    await docs.model.update({ name: '{{ literal customer name }}' }, { where: { id: 3 } });
    const ctx = await context('update', {
      filter: { name: '{{ literal customer name }}' },
      values: { name: 'Changed' },
    });
    await handler.handle(ctx, auth(), () => context('list'));
    expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B' });
  });

  it('rejects source metadata changes during filtered mutation authorization', async () => {
    const ctx = await context('update', { filter: { name: 'Owned' }, values: { name: 'Forbidden' } });
    const attribute = docs.model.rawAttributes.name;
    const original = attribute.field;
    try {
      await expect(
        handler.handle(ctx, auth(), async () => {
          attribute.field = 'other_name';
          return context('list');
        }),
      ).rejects.toThrow();
      expect(ctx.body).toBe('unchanged');
    } finally {
      attribute.field = original;
    }
    expect(await read()).toMatchObject({ name: 'Owned', tenantId: 'B' });
  });

  it.each([
    { filter: { $or: [{}, { name: 'Other' }] }, allowed: true },
    { filter: { $or: [] }, allowed: false },
    { filter: { $not: { $or: [] } }, allowed: true },
    { filter: { $not: {} }, allowed: false },
  ])('preserves logical constant semantics for $filter', async ({ filter, allowed }) => {
    const ctx = await context('update', { filter, values: { name: 'Changed' } });
    const update = handler.handle(ctx, auth(), () => context('list'));
    if (allowed) {
      await update;
      expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B' });
    } else {
      await expect(update).rejects.toThrow();
      expect(ctx.body).toBe('unchanged');
      expect(await read()).toMatchObject({ name: 'Owned', tenantId: 'B' });
    }
  });

  it('rolls back all filtered keys if a later repository hook fails', async () => {
    await docs.model.create({ id: 7, tenantId: 'B', name: 'Owned', amount: 70 });
    const ctx = await context('update', { filterByTk: [3, 7], filter: { name: 'Owned' }, values: { name: 'Changed' } });
    db.on('documents.afterUpdate', (record) => {
      if (record.get('id') === 7) throw new Error('Late filtered failure');
    });
    await expect(handler.handle(ctx, auth(), () => context('list'))).rejects.toThrow('Late filtered failure');
    expect(await read()).toMatchObject({ name: 'Owned', amount: 30 });
    expect(await read(7)).toMatchObject({ name: 'Owned', amount: 70 });
    expect(ctx.body).toBe('unchanged');
  });

  it('claims editable legacy data only after the request and read scopes match', async () => {
    await configure(configFor({ type: 'constant', value: true }));
    const rejected = await context('update', { filterByTk: 5, filter: { name: 'Other' }, values: { name: 'Changed' } });
    await expect(handler.handle(rejected, auth(), () => context('list'))).rejects.toThrow();
    expect(await read(5)).toMatchObject({ name: 'Legacy', tenantId: null });
    const allowed = await context('update', { filterByTk: 5, filter: { name: 'Legacy' }, values: { name: 'Claimed' } });
    await handler.handle(allowed, auth(), () => context('list'));
    expect(await read(5)).toMatchObject({ name: 'Claimed', tenantId: 'B' });
  });

  it.skipIf(dialect !== 'postgres')(
    'retains hidden role facts in the independent read scope during filtered writes',
    async () => {
      docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
      const ctx = await context('update', { filter: { name: 'Owned' }, values: { name: 'Changed' } });
      await handler.handle(ctx, auth(), () =>
        context('list', {}, { fields: ['name'], filter: { owner: { enabled: true } } }),
      );
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
      expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B' });
    },
  );

  it.each(['whitelist', 'blacklist'])('accepts an omitted association in the finalized %s', async (fieldList) => {
    docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
    const ctx = await context('update', { values: { name: 'Changed' } });
    Object.assign((ctx.permission as { parsedParams: object }).parsedParams, {
      [fieldList]: fieldList === 'whitelist' ? ['name', 'owner'] : ['owner'],
    });
    await handler.handle(ctx, auth());
    expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B', amount: 30 });
  });

  it.each([{ fields: [] }, { fields: ['name'] }, { fields: ['owner'] }])(
    'accepts destroy field metadata $fields without requiring a write whitelist',
    async ({ fields }) => {
      docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
      const ctx = await context('destroy', {}, { fields });
      await handler.handle(ctx, auth());
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
      expect(await read()).toBeUndefined();
    },
  );

  it.each([null, 'name', [1], ['name', 'name'], ['missing']].map((fields) => ({ fields })))(
    'rejects invalid destroy field metadata $fields before SQL',
    async ({ fields }) => {
      const ctx = await context('destroy');
      Object.assign(ctx.permission as object, { parsedParams: { fields } });
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(handler.handle(ctx, auth())).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
      expect(await read()).toMatchObject({ name: 'Owned', tenantId: 'B' });
    },
  );

  it.each(['update', 'destroy'])(
    'applies %s to every explicitly selected authorized record once',
    async (operation) => {
      await docs.model.create({ id: 6, tenantId: 'B', name: 'Owned', amount: 60 });
      const write = vi.spyOn(docs.repository, operation as 'update' | 'destroy');
      const ctx = await context(
        operation,
        {
          filterByTk: ['006', 3, '03', 6],
          ...(operation === 'update' ? { values: { name: 'Submitted', amount: 999 } } : {}),
        },
        { ...(operation === 'update' ? { fields: ['name'] } : {}), filter: { name: 'Owned' } },
      );
      await handler.handle(ctx, auth());
      expect(ctx.body).toEqual({ keys: [3, 6], affected: 2 });
      expect(write).toHaveBeenCalledTimes(2);
      for (const id of [3, 6])
        if (operation === 'update')
          expect(await read(id)).toMatchObject({ name: 'Submitted', amount: id === 3 ? 30 : 60, tenantId: 'B' });
        else expect(await read(id)).toBeUndefined();
    },
  );

  it.each([1, 1000])('accepts %i explicit keys before normalization and deduplication', async (size) => {
    const ctx = await context('update', { filterByTk: Array(size).fill(3), values: { name: 'Changed' } });
    const write = vi.spyOn(docs.repository, 'update');
    await handler.handle(ctx, auth());
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B' });
  });

  it.each(['update', 'destroy'])('refuses the whole %s selection if any record is unavailable', async (operation) => {
    for (const id of [1, 4, 99]) {
      const ctx = await context(operation, {
        filterByTk: [3, id],
        ...(operation === 'update' ? { values: { name: 'Bad' } } : {}),
      });
      const write = vi.spyOn(docs.repository, operation as 'update' | 'destroy');
      await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(write).not.toHaveBeenCalled();
      expect(await read()).toMatchObject({ name: 'Owned', tenantId: 'B' });
      expect(ctx.body).toBe('unchanged');
      write.mockRestore();
    }
  });

  it.each(['update', 'destroy'])('checks the role filter for every selected %s record', async (operation) => {
    await docs.model.create({ id: 6, tenantId: 'B', name: 'Other', amount: 60 });
    const ctx = await context(
      operation,
      { filterByTk: [3, 6], ...(operation === 'update' ? { values: { name: 'Bad' } } : {}) },
      { filter: { name: 'Owned' } },
    );
    const write = vi.spyOn(docs.repository, operation as 'update' | 'destroy');
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(write).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({ name: 'Owned' });
    expect(await read(6)).toMatchObject({ name: 'Other' });
    expect(ctx.body).toBe('unchanged');
  });

  it('claims an allowed historical record together with ordinary selected records', async () => {
    await configure(configFor({ type: 'constant', value: true }));
    const ctx = await context('update', { filterByTk: [3, 5], values: { name: 'Changed' } });
    await handler.handle(ctx, auth());
    expect(ctx.body).toEqual({ keys: [3, 5], affected: 2 });
    for (const id of [3, 5]) expect(await read(id)).toMatchObject({ name: 'Changed', tenantId: 'B' });
  });

  it.each(['update', 'destroy'])(
    'keeps the whole %s selection unchanged for read-only historical data',
    async (operation) => {
      const ctx = await context(operation, {
        filterByTk: [3, 5],
        ...(operation === 'update' ? { values: { name: 'Bad' } } : {}),
      });
      await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
      expect(await read()).toMatchObject({ name: 'Owned', tenantId: 'B' });
      expect(await read(5)).toMatchObject({ name: 'Legacy', tenantId: null });
      expect(ctx.body).toBe('unchanged');
    },
  );

  it.each(['update', 'destroy'])(
    'rolls back earlier %s writes when the last selected record fails',
    async (operation) => {
      await docs.model.create({ id: 6, tenantId: 'B', name: 'Owned', amount: 60 });
      const notifications = vi.fn();
      docs.model.addHook(
        operation === 'update' ? 'afterUpdate' : 'afterDestroy',
        'batch-failure',
        (record, options) => {
          options.transaction.afterCommit(notifications);
          if (record.get('id') === 6) throw new Error('last record failed');
        },
      );
      const ctx = await context(operation, {
        filterByTk: [6, 3],
        ...(operation === 'update' ? { values: { name: 'Bad' } } : {}),
      });
      const write = vi.spyOn(docs.repository, operation as 'update' | 'destroy');
      await expect(handler.handle(ctx, auth())).rejects.toThrow('last record failed');
      expect(write).toHaveBeenCalledTimes(2);
      for (const id of [3, 6]) expect(await read(id)).toMatchObject({ name: 'Owned', tenantId: 'B' });
      expect(notifications).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
    },
  );

  it('preserves each selected owner under a broader ownership rule', async () => {
    await configure(configFor({ type: 'constant', value: true }));
    const ctx = await context('update', { filterByTk: [3, 4], values: { name: 'Changed' } });
    await handler.handle(ctx, auth());
    expect(await read(3)).toMatchObject({ name: 'Changed', tenantId: 'B' });
    expect(await read(4)).toMatchObject({ name: 'Changed', tenantId: 'C' });
  });

  it('rolls back all selected writes when a later hook changes persisted ownership', async () => {
    await docs.model.create({ id: 6, tenantId: 'B', name: 'Owned', amount: 60 });
    const notifications = vi.fn();
    docs.model.addHook('afterUpdate', 'batch-transfer', async (record, options) => {
      options.transaction.afterCommit(notifications);
      if (record.get('id') === 6)
        await docs.model.update(
          { tenantId: 'C' },
          { where: { id: 6 }, transaction: options.transaction, hooks: false },
        );
    });
    const ctx = await context('update', { filterByTk: [3, 6], values: { name: 'Changed' } });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    for (const id of [3, 6]) expect(await read(id)).toMatchObject({ name: 'Owned', tenantId: 'B' });
    expect(notifications).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
  });

  it('rejects ownership transfers for the whole selection even when filtered from field grants', async () => {
    await configure(configFor({ type: 'constant', value: true }));
    const ctx = await context(
      'update',
      { filterByTk: [3, 4], values: { name: 'Bad', tenantId: 'B' } },
      { fields: ['name'] },
    );
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(await read(3)).toMatchObject({ name: 'Owned', tenantId: 'B' });
    expect(await read(4)).toMatchObject({ name: 'Hidden', tenantId: 'C' });
    expect(ctx.body).toBe('unchanged');
  });

  it.each([
    'prototype',
    'sparse',
    'accessor',
    'extra',
    'symbol',
    'empty',
    'oversized',
    'object',
    'nested',
    'unsafe',
    'long',
  ])('rejects a %s key array before SQL without evaluating getters', async (kind) => {
    const locator: unknown[] = [3];
    const getter = vi.fn(() => 3);
    if (kind === 'prototype') Object.setPrototypeOf(locator, null);
    if (kind === 'sparse') locator.length = 2;
    if (kind === 'accessor') Object.defineProperty(locator, 0, { get: getter });
    if (kind === 'extra') Object.defineProperty(locator, 'extra', { value: 3 });
    if (kind === 'symbol') Object.defineProperty(locator, Symbol('extra'), { value: 3 });
    if (kind === 'empty') locator.length = 0;
    if (kind === 'oversized') locator.length = 1001;
    if (kind === 'object') locator[0] = {};
    if (kind === 'nested') locator[0] = [3];
    if (kind === 'unsafe') locator[0] = Number.MAX_SAFE_INTEGER + 1;
    if (kind === 'long') locator[0] = '3'.repeat(256);
    const ctx = await context('update', { values: { name: 'Bad' } });
    // Preserve the original shape at the finalized handler boundary, before any core cloning.
    (ctx.permission as { rawParams: { filterByTk: unknown } }).rawParams.filterByTk = locator;
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(sql).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
  });

  it.each(['update', 'destroy'])('does not let visibility grant %s', async (operation) => {
    const ctx = await context(operation, {
      filterByTk: 1,
      filter: {},
      ...(operation === 'update' ? { values: { name: 'Bad' } } : {}),
    });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await read(1)).toMatchObject({ name: 'Visible', tenantId: 'H' });
    expect(ctx.body).toBe('unchanged');
  });

  it('uses resolved role conditions instead of merged request params', async () => {
    const ctx = await context('update', { filter: {}, values: { name: 'Bad' } }, { filter: { name: 'Other' } });
    ctx.action.mergeParams({ filter: {} });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect((await read()).name).toBe('Owned');
  });

  it('retains ACL variables resolved by the real core middleware', async () => {
    const ctx = await context(
      'update',
      { values: { amount: 31 } },
      { filter: { name: '{{ ctx.state.currentUser.name }}' } },
    );
    await handler.handle(ctx, auth());
    expect((await read()).amount).toBe(31);
  });

  it('applies a finalized blacklist together with the whitelist', async () => {
    const ctx = await context('update', { values: { name: 'Changed', amount: 999 } });
    Object.assign((ctx.permission as { parsedParams: object }).parsedParams, {
      whitelist: ['name', 'amount'],
      blacklist: ['amount'],
    });
    await handler.handle(ctx, auth());
    expect(await read()).toMatchObject({ name: 'Changed', amount: 30 });
  });

  it.each([
    [{ $or: [{ $and: [] }, { name: 'Other' }] }, true],
    [{ $and: [{ $or: [] }, { name: 'Owned' }] }, false],
    [{ $not: { $or: [] } }, true],
    [{ $not: { $and: [] } }, false],
    [{ $not: { name: { $eq: 'Other' } } }, false],
    [{ $or: [{ $or: [] }, { name: 'Owned' }] }, true],
  ] as const)('keeps scalar role boolean and NULL semantics for %j', async (filter, permitted) => {
    if ('$not' in filter && typeof filter.$not === 'object' && 'name' in filter.$not)
      await docs.model.update({ name: null }, { where: { id: 3 } });
    const ctx = await context('update', { values: { amount: 31 } });
    Object.assign((ctx.permission as { parsedParams: object }).parsedParams, { filter });
    if (permitted) await handler.handle(ctx, auth());
    else await expect(handler.handle(ctx, auth())).rejects.toThrow();
    expect((await read()).amount).toBe(permitted ? 31 : 30);
  });

  it('evaluates hidden related role facts in the write transaction without granting their output', async () => {
    docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
    const ctx = await context(
      'update',
      { values: { name: 'Changed' } },
      {
        fields: ['name'],
        filter: { owner: { enabled: true } },
      },
    );
    if (dialect === 'sqlite') {
      await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
      expect((await read()).name).toBe('Owned');
    } else {
      await handler.handle(ctx, auth());
      expect((await read()).name).toBe('Changed');
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    }
  });

  it('denies a relational role condition even when G matches', async () => {
    docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
    const ctx = await context('update', { values: { name: 'Bad' } }, { filter: { owner: { enabled: false } } });
    await expect(handler.handle(ctx, auth())).rejects.toThrow();
    expect((await read()).name).toBe('Owned');
  });

  it('succeeds when a valid edit leaves its former role scope', async () => {
    const ctx = await context('update', { values: { name: 'Submitted' } }, { filter: { name: 'Owned' } });
    await handler.handle(ctx, auth());
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    expect((await read()).name).toBe('Submitted');
  });

  it('claims an editable legacy record for the active tenant', async () => {
    await configure(configFor({ type: 'constant', value: true }));
    const ctx = await context(
      'update',
      { filterByTk: 5, values: { name: 'Claimed', tenantId: null } },
      { fields: ['name'] },
    );
    await handler.handle(ctx, auth());
    expect(await read(5)).toMatchObject({ name: 'Claimed', tenantId: 'B' });
  });

  it('keeps a visible legacy record read-only without ownership authorization', async () => {
    const ctx = await context('update', { filterByTk: 5, values: { name: 'Bad' } });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect(await read(5)).toMatchObject({ name: 'Legacy', tenantId: null });
  });

  it('forbids direct legacy deletion even when ownership rules match', async () => {
    await configure(configFor({ type: 'constant', value: true }));
    const ctx = await context('destroy', { filterByTk: 5 });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect(await read(5)).toBeDefined();
  });

  it('does not accept ordinary ownership transfers', async () => {
    const ctx = await context('update', { values: { name: 'Bad', tenantId: 'C' } }, { fields: ['name'] });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(await read()).toMatchObject({ name: 'Owned', tenantId: 'B' });
  });

  it.each([
    { filterByTk: undefined },
    { filterByTk: [3, 4], resourceIndex: 3 },
    { filterByTk: [3], resourceIndex: 3 },
    { filterByTk: '_' },
    { filter: { id: 3 } },
    { updateAssociationValues: ['tenant'] },
    { hooks: false },
    { transaction: {} },
    { values: [{ name: 'Bad' }] },
    { resourceIndex: 4 },
    { associatedName: 'tenants' },
    { resourceName: 'other' },
    { fields: ['name'] },
  ])('rejects unsupported or conflicting request %j before SQL', async (extra) => {
    const ctx = await context('update', { values: { name: 'Bad' }, ...extra });
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(ctx, auth())).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
  });

  it.each([
    { can: false },
    { parsedParams: undefined },
    { resourceName: 'other' },
    { can: { resource: 'documents', action: 'update', role: 'other' } },
    { parsedParams: { own: true } },
    { parsedParams: { fields: [] } },
    { parsedParams: { whitelist: [] } },
    { parsedParams: { whitelist: ['name', 'name'] } },
    { parsedParams: { whitelist: ['missing'] } },
    { parsedParams: { filter: null } },
    { parsedParams: { filter: { name: '{{ unresolved }}' } } },
  ])('rejects missing or mismatched finalized authorization %j before SQL', async (extra) => {
    const ctx = await context('update', { values: { name: 'Bad' } });
    Object.assign(ctx.permission as object, extra);
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(ctx, auth())).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
  });

  it('rolls back writes and keeps the response when a repository hook fails', async () => {
    const ctx = await context('update', { values: { name: 'Bad' } });
    docs.model.addHook('afterUpdate', 'failure', () => {
      throw new Error('hook failed');
    });
    await expect(handler.handle(ctx, auth())).rejects.toThrow('hook failed');
    expect((await read()).name).toBe('Owned');
    expect(ctx.body).toBe('unchanged');
  });

  it.each(['update', 'destroy'] as const)('rejects a changed repository target key before %s', async (operation) => {
    await docs.model.update({ amount: 3 }, { where: { id: 4 } });
    const ctx = await context(operation, operation === 'update' ? { values: { name: 'Bad' } } : {});
    const original = docs.model.findAll;
    let queries = 0;
    vi.spyOn(docs.model, 'findAll').mockImplementation(async function (this: typeof docs.model, ...args) {
      const rows = await original.apply(this, args);
      if (++queries === 2) docs.options.filterTargetKey = 'amount';
      return rows;
    });
    const write = vi.spyOn(docs.repository, operation);
    await expect(handler.handle(ctx, auth())).rejects.toThrow(/identity|target|metadata/i);
    expect(write).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({ name: 'Owned', tenantId: 'B' });
    expect(await read(4)).toMatchObject({ name: 'Hidden', tenantId: 'C' });
    expect(ctx.body).toBe('unchanged');
  });

  it.each(['update', 'destroy'])('rolls back %s if the prepared phase ends during persistence', async (operation) => {
    const ctx = await context(operation, operation === 'update' ? { values: { name: 'Bad' } } : {});
    docs.model.addHook(operation === 'update' ? 'afterUpdate' : 'afterDestroy', 'end-phase', () => {
      adapter.release(ctx);
    });
    await expect(handler.handle(ctx, auth())).rejects.toThrow(/phase|prepared/);
    expect((await read()).name).toBe('Owned');
    expect(ctx.body).toBe('unchanged');
  });

  it.runIf(dialect === 'postgres')(
    'rolls back when a role relationship changes after the final verification query',
    async () => {
      docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
      const ctx = await context('update', { values: { name: 'Bad' } }, { filter: { owner: { enabled: true } } });
      const original = docs.model.findAll;
      let afterWrite = false;
      docs.model.addHook('afterUpdate', 'mark-written', () => {
        afterWrite = true;
      });
      vi.spyOn(docs.model, 'findAll').mockImplementation(async function (this: typeof docs.model, ...args) {
        const rows = await original.apply(this, args);
        if (afterWrite) docs.model.associations.owner = { ...docs.model.associations.owner } as never;
        return rows;
      });
      await expect(handler.handle(ctx, auth())).rejects.toThrow(/metadata|association/i);
      expect((await read()).name).toBe('Owned');
      expect(ctx.body).toBe('unchanged');
    },
  );

  it.each(['source', 'database', 'role', 'identity', 'target key'])(
    'rejects incompatible %s before SQL',
    async (kind) => {
      const ctx = await context('update', { values: { name: 'Bad' } });
      const authenticated = auth();
      if (kind === 'source') Object.assign(ctx.action, { sourceId: '_' });
      if (kind === 'database') ctx.db = {} as Database;
      if (kind === 'role') authenticated.roleName = 'other';
      if (kind === 'target key') docs.options.filterTargetKey = 'name';
      const active =
        kind === 'identity'
          ? new AccessRootMutationHandler(
              db,
              adapter,
              new AccessQueryService(db, adapter, () => accessCollectionKey(mainIdentity)),
              () => ({ ...mainIdentity, collectionKey: 'recreated' }),
            )
          : handler;
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(active.handle(ctx, authenticated)).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
    },
  );

  it('captures request and authenticated identity before metadata callbacks', async () => {
    const ctx = await context('update', { values: { name: 'Changed' } });
    const authenticated = auth();
    const currentHandler = new AccessRootMutationHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      (collection) => {
        authenticated.tenantId = 'C';
        (ctx.permission as { rawParams: { values: object } }).rawParams.values = { name: 'Injected' };
        return identity(collection);
      },
    );
    await currentHandler.handle(ctx, authenticated);
    expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B' });
  });
});
