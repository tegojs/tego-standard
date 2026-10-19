import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

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

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('finalized root creation (%s)', (dialect) => {
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
      tableName: 'creation_handler_documents',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'name', type: 'string', defaultValue: 'Draft' },
        { name: 'amount', type: 'integer', defaultValue: 10 },
      ],
    });
    const tenants = db.collection({
      name: 'tenants',
      tableName: 'creation_handler_tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await docs.model.sync();
    await tenants.model.sync();
    await tenants.model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
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

  async function context(params: Record<string, unknown> = {}, permission: object = {}) {
    const acl = new ACL();
    acl.setAvailableAction('create', {});
    acl.define({ role: 'editor' }).grantAction('documents:create', permission);
    const resourcer = new Resourcer();
    resourcer.define({ name: 'documents', actions: { create: {} } });
    const action = resourcer.getAction('documents', 'create').clone();
    Object.assign(action, {
      resourceName: 'documents',
      actionName: 'create',
      sourceId: undefined,
      resourceOf: undefined,
    });
    action.mergeParams({ resourceName: 'documents', actionName: 'create', values: { name: 'Created' }, ...params });
    const result = {
      db,
      action,
      state: { currentRole: 'editor', currentUser: { id: 28, name: 'Created' } },
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

  const rows = async () => (await docs.model.findAll({ order: [['id', 'ASC']] })).map((record) => record.get());

  it('creates with final field grants, generated key, model defaults and current ownership', async () => {
    const ctx = await context({ values: { name: 'Created', amount: 999 } }, { fields: ['name'] });
    await handler.handle(ctx, auth());
    expect(ctx.body).toEqual({ keys: [expect.any(Number)], affected: 1 });
    expect(await rows()).toEqual([
      { id: (ctx.body as { keys: number[] }).keys[0], name: 'Created', amount: 10, tenantId: 'B' },
    ]);
  });

  it('allows model defaults when the finalized whitelist excludes every client field', async () => {
    const ctx = await context({}, { fields: [] });
    await handler.handle(ctx, auth());
    expect(await rows()).toMatchObject([{ name: 'Draft', tenantId: 'B' }]);
  });

  it('applies a finalized blacklist', async () => {
    const ctx = await context({ values: { name: 'Created', amount: 999 } });
    Object.assign((ctx.permission as { parsedParams: object }).parsedParams, { blacklist: ['amount'] });
    await handler.handle(ctx, auth());
    expect(await rows()).toMatchObject([{ name: 'Created', amount: 10 }]);
  });

  it.each([undefined, null, 'B'])('assigns active ownership for client tenantId %s', async (tenantId) => {
    const ctx = await context({ values: { name: 'Created', tenantId } }, { fields: ['name'] });
    await handler.handle(ctx, auth());
    expect(await rows()).toMatchObject([{ tenantId: 'B' }]);
  });

  it('rejects forged ownership even when tenantId is outside the role whitelist', async () => {
    const ctx = await context({ values: { name: 'Bad', tenantId: 'C' } }, { fields: ['name'] });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it('does not let visibility alone grant create', async () => {
    await configure(configFor({ type: 'constant', value: true }, 'visibility'));
    const ctx = await context();
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it('checks resolved create role conditions against persisted defaults and ignores merged parameters', async () => {
    const ctx = await context({ values: {} }, { filter: { name: 'Draft', amount: 10 } });
    ctx.action.mergeParams({ values: { name: 'Injected' }, filter: { name: 'Injected' } });
    await handler.handle(ctx, auth());
    expect(await rows()).toMatchObject([{ name: 'Draft', amount: 10 }]);
  });

  it('keeps the actual ACL variable resolution', async () => {
    const ctx = await context({}, { filter: { name: '{{ ctx.state.currentUser.name }}' } });
    await handler.handle(ctx, auth());
    expect(await rows()).toMatchObject([{ name: 'Created' }]);
  });

  it('rolls back a new record outside its final create role condition', async () => {
    const ctx = await context({}, { filter: { name: 'Other' } });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it('requires an active tenant when ownership is managed', async () => {
    const ctx = await context();
    await expect(handler.handle(ctx, { roleName: 'editor', userId: 28 })).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  it('keeps explicitly shared creation usable without a tenant', async () => {
    await configure({ ...configFor({ type: 'constant', value: true }), ownership: { enabled: false } });
    const ctx = await context();
    await handler.handle(ctx, { roleName: 'editor', userId: 28 });
    expect(await rows()).toMatchObject([{ name: 'Created', tenantId: null }]);
  });

  it.each([
    { values: undefined },
    { values: null },
    { values: [{ name: 'Bad' }] },
    { values: { missing: 'Bad' } },
    { filterByTk: 3 },
    { resourceIndex: 3 },
    { filter: {} },
    { updateAssociationValues: ['owner'] },
    { hooks: false },
    { transaction: {} },
    { fields: ['name'] },
    { appends: ['owner'] },
    { associatedName: 'owner' },
  ])('rejects unsupported creation input %j before SQL', async (extra) => {
    const ctx = await context(extra);
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(ctx, auth())).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
  });

  it.each([
    { can: false },
    { can: { resource: 'documents', action: 'update', role: 'editor' } },
    { parsedParams: undefined },
    { parsedParams: { own: true } },
    { parsedParams: { filter: null } },
  ])('rejects missing or incompatible create authorization %j before SQL', async (extra) => {
    const ctx = await context();
    Object.assign(ctx.permission as object, extra);
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(ctx, auth())).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
    expect(ctx.body).toBe('unchanged');
  });

  it('rejects physical foreign-key input before SQL', async () => {
    docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
    docs.setField('approver', { type: 'belongsTo', target: 'tenants', foreignKey: 'approverId' });
    const ctx = await context({ values: { name: 'Bad', approverId: 'B' } });
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(ctx, auth())).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
  });

  it('runs repository hooks and rolls back their errors', async () => {
    const ctx = await context();
    docs.model.addHook('afterCreate', 'failure', () => {
      throw new Error('hook failed');
    });
    await expect(handler.handle(ctx, auth())).rejects.toThrow('hook failed');
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it('rolls back when the prepared phase ends in a create hook', async () => {
    const ctx = await context();
    docs.model.addHook('afterCreate', 'end-phase', () => {
      adapter.release(ctx);
    });
    await expect(handler.handle(ctx, auth())).rejects.toThrow(/phase|prepared/);
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it('captures the original input and identity before metadata callbacks', async () => {
    const ctx = await context();
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
    expect(await rows()).toMatchObject([{ name: 'Created', tenantId: 'B' }]);
  });

  it('rejects client association objects before SQL even when excluded by role fields', async () => {
    docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
    const ctx = await context({ values: { name: 'Bad', owner: { id: 'B' } } }, { fields: ['name'] });
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(ctx, auth())).rejects.toThrow();
    expect(sql).not.toHaveBeenCalled();
  });

  it('rolls back ownership changes made by a model hook', async () => {
    const ctx = await context();
    docs.model.addHook('beforeCreate', 'change-owner', (record) => {
      record.setDataValue('tenantId', 'C');
    });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it('checks role restrictions after model hooks change a new record', async () => {
    const ctx = await context({}, { filter: { name: 'Created' } });
    docs.model.addHook('beforeCreate', 'change-name', (record) => {
      record.setDataValue('name', 'Other');
    });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it('evaluates hidden related create conditions in the same write transaction', async () => {
    docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
    const ctx = await context({}, { fields: ['name'], filter: { owner: { enabled: true } } });
    if (dialect === 'sqlite') {
      await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
      expect(await rows()).toEqual([]);
    } else {
      await handler.handle(ctx, auth());
      expect(await rows()).toMatchObject([{ name: 'Created', tenantId: 'B' }]);
      expect(ctx.body).toEqual({ keys: [expect.any(Number)], affected: 1 });
    }
  });

  it.runIf(dialect === 'postgres')('rolls back an unmet related create condition', async () => {
    docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
    const ctx = await context({}, { filter: { owner: { enabled: false } } });
    await expect(handler.handle(ctx, auth())).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it('rolls back metadata changes after the final persisted authorization query', async () => {
    const ctx = await context();
    const original = docs.model.findAll;
    let queries = 0;
    vi.spyOn(docs.model, 'findAll').mockImplementation(async function (this: typeof docs.model, ...args) {
      const result = await original.apply(this, args);
      if (++queries === 2) docs.model.rawAttributes.amount.primaryKey = true;
      return result;
    });
    await expect(handler.handle(ctx, auth())).rejects.toThrow(/metadata/i);
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  it.runIf(dialect === 'postgres')(
    'rolls back role relationship changes after the final authorization query',
    async () => {
      docs.setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'tenantId' });
      const ctx = await context({}, { filter: { owner: { enabled: true } } });
      const original = docs.model.findAll;
      let queries = 0;
      vi.spyOn(docs.model, 'findAll').mockImplementation(async function (this: typeof docs.model, ...args) {
        const result = await original.apply(this, args);
        if (++queries === 2) docs.model.associations.owner = { ...docs.model.associations.owner } as never;
        return result;
      });
      await expect(handler.handle(ctx, auth())).rejects.toThrow(/metadata|association/i);
      expect(await rows()).toEqual([]);
      expect(ctx.body).toBe('unchanged');
    },
  );
});
