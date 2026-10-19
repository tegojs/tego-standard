import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessHasManyMutationHandler } from '../../access-control/has-many-mutation-handler';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const childIdentity = { ...mainIdentity, collectionName: 'children', collectionKey: 'children-key' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('finalized has-many mutations (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let children: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessHasManyMutationHandler;
  const actor = () => ({ tenantId: 'B', roleName: 'editor', userId: 28 });
  const identity = (collection: Collection) => (collection === docs ? mainIdentity : childIdentity);
  const pg = (name: string, run: () => Promise<void>) => it.skipIf(dialect !== 'postgres')(name, run);

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    const fields = [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'tenantId', type: 'string' },
      { name: 'name', type: 'string' },
    ];
    docs = db.collection({ name: 'documents', timestamps: false, fields });
    children = db.collection({
      name: 'children',
      timestamps: false,
      fields: [...fields, { name: 'documentId', type: 'integer', field: 'document_id' }],
    });
    docs.setField('children', { type: 'hasMany', target: 'children', foreignKey: 'documentId' });
    children.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.sync();
    await db.getRepository('tenants').create({ values: { id: 'B', enabled: true } });
    await docs.repository.create({
      values: [
        { id: 1, tenantId: 'H', name: 'Shared' },
        { id: 3, tenantId: 'B', name: 'Owned' },
        { id: 4, tenantId: 'C', name: 'Hidden' },
        { id: 5, tenantId: null, name: 'Legacy' },
      ],
    });
    await children.repository.create({
      values: [
        { id: 101, tenantId: 'B', name: 'Owned', documentId: null },
        { id: 102, tenantId: 'H', name: 'Shared', documentId: null },
        { id: 103, tenantId: 'C', name: 'Hidden', documentId: null },
        { id: 104, tenantId: null, name: 'Legacy', documentId: null },
        { id: 105, tenantId: 'B', name: 'Owned', documentId: 3 },
        { id: 106, tenantId: 'B', name: 'Owned', documentId: 4 },
      ],
    });
    await db.getRepository('collections').create({ values: { key: childIdentity.collectionKey, name: 'children' } });
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor(
        {
          type: 'any',
          children: [
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'field', path: 'name' },
              right: { type: 'literal', value: 'Shared' },
            },
            { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
          ],
        },
        'visibility',
      ).rules[0],
      id: 'visible',
    });
    for (const value of [mainIdentity, childIdentity])
      await store.save(value, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    handler = new AccessHasManyMutationHandler(
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

  async function context(
    resourceName: string,
    actionName: string,
    params: object = {},
    grant: object = {},
    source?: string,
  ) {
    const acl = new ACL();
    for (const action of ['add', 'remove', 'set', 'update', 'list']) acl.setAvailableAction(action, {});
    acl.define({ role: 'editor' }).grantAction(`${resourceName}:${actionName}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: resourceName, actions: { add: {}, remove: {}, set: {}, update: {}, list: {} } });
    const action = resourcer.getAction(resourceName, actionName).clone();
    Object.assign(action, {
      resourceName: source === undefined ? resourceName : 'documents.children',
      actionName,
      sourceId: source,
      resourceOf: source,
    });
    action.mergeParams({
      resourceName,
      actionName,
      filterByTk: undefined,
      ...(source === undefined ? {} : { associatedName: 'documents', associatedIndex: source }),
      ...params,
    });
    const ctx = {
      db,
      action,
      permission: undefined as unknown,
      body: 'unchanged' as unknown,
      state: { currentRole: 'editor', currentUser: { id: 28, name: 'Owned' } },
      get: () => '+08:00',
      logger: { info: vi.fn() },
      throw: (status: number) => {
        throw new Error(String(status));
      },
    };
    await adapter.prepare(ctx, [mainIdentity, childIdentity]);
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  const association = (operation = 'add', params: object = { values: [101] }, grant = {}, source = '3') =>
    context('children', operation, params, grant, source);
  const run = async (ctx: Awaited<ReturnType<typeof context>>, sourceGrant = {}, updateGrant = {}, readGrant = {}) => {
    const source = await context('documents', ctx.action.actionName, {}, sourceGrant);
    const update = await context('children', 'update', {}, updateGrant);
    const read = await context('children', 'list', {}, readGrant);
    return handler.handle(
      ctx,
      actor(),
      async () => source,
      async () => update,
      async () => read,
    );
  };
  const linked = async () =>
    (await children.model.findAll({ attributes: ['id'], where: { documentId: 3 }, order: [['id', 'ASC']] })).map(
      (row) => Number(row.get('id')),
    );

  pg('binds children using independent source, update field and list grants', async () => {
    const ctx = await association();
    await run(ctx, { fields: ['children'] }, { fields: ['document'] }, { fields: ['id'] });
    expect(await linked()).toEqual([101, 105]);
    expect(ctx.body).toEqual({ keys: [101], affected: 1 });
    expect((await children.model.findByPk(101))!.get('tenantId')).toBe('B');
  });
  pg('supports physical foreign-key grants and a scalar selector', async () => {
    await run(await association('add', { filterByTk: 106 }), {}, { fields: ['documentId'] });
    expect(await linked()).toEqual([105, 106]);
    expect((await docs.model.findByPk(4))!.get('name')).toBe('Hidden');
  });
  pg('sets and clears with independent updates on implicitly removed children', async () => {
    await run(await association('set', { filterByTks: [101] }));
    expect(await linked()).toEqual([101]);
    const ctx = await association('set', { values: [] });
    const source = await context('documents', 'set');
    const update = await context('children', 'update');
    const read = vi.fn(async () => null);
    await handler.handle(
      ctx,
      actor(),
      async () => source,
      async () => update,
      read,
    );
    expect(read).not.toHaveBeenCalled();
    expect(await linked()).toEqual([]);
  });
  pg('removes only selected links and preserves unrelated children', async () => {
    const ctx = await association('remove', { values: [105, 106] });
    await run(ctx);
    expect(await linked()).toEqual([]);
    expect((await children.model.findByPk(105))!.get('documentId')).toBeNull();
    expect((await children.model.findByPk(106))!.get('documentId')).toBe(4);
    expect(ctx.body).toEqual({ keys: [105], affected: 1 });
  });
  pg('does not require update permission when selected links stay unchanged', async () => {
    await children.model.update({ tenantId: 'H', name: 'Shared' }, { where: { id: 105 } });
    const ctx = await association('add', { values: [105] });
    const source = await context('documents', 'add');
    const read = await context('children', 'list');
    const update = vi.fn(async () => null);
    await handler.handle(
      ctx,
      actor(),
      async () => source,
      update,
      async () => read,
    );
    expect(update).not.toHaveBeenCalled();
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
  });
  pg('requires source ownership even with an allowed target operation', async () => {
    await expect(run(await association('add', { values: [101] }, {}, '1'))).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect((await children.model.findByPk(101))!.get('documentId')).toBeNull();
  });
  pg('does not turn visible children into writable children', async () => {
    await expect(run(await association('add', { values: [102] }))).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await linked()).toEqual([105]);
  });
  pg('authorizes target action and root update conditions independently', async () => {
    await expect(run(await association('add', { values: [101] }, { filter: { name: 'Other' } }))).rejects.toMatchObject(
      { code: 'ACCESS_RECORD_UNAVAILABLE' },
    );
    await expect(run(await association(), {}, { filter: { name: 'Other' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await linked()).toEqual([105]);
  });
  pg('rejects an implicit removal outside target update conditions and rolls back the whole replacement', async () => {
    await expect(run(await association('set', { values: [101] }), {}, { filter: { id: 101 } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await linked()).toEqual([105]);
  });
  pg('does not borrow source permissions for a hidden or filtered target read', async () => {
    await expect(run(await association('add', { values: [103] }))).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    await expect(run(await association(), {}, {}, { filter: { name: 'Other' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await linked()).toEqual([105]);
  });
  it
    .skipIf(dialect !== 'postgres')
    .each([
      { fields: ['name'] },
      { blacklist: ['document'] },
      { blacklist: ['documentId'] },
      { fields: ['documentId'], blacklist: ['document'] },
    ])('requires writable child foreign-key grants %j', async (grant) => {
    await expect(run(await association(), {}, grant)).rejects.toThrow();
    expect(await linked()).toEqual([105]);
  });
  it.skipIf(dialect !== 'postgres').each(['denied', 'role', 'action', 'resource', 'database', 'filtered', 'locator'])(
    'rejects invalid target update decisions %s',
    async (kind) => {
      const ctx = await association();
      const source = await context('documents', 'add');
      const update = await context('children', 'update');
      const read = await context('children', 'list');
      const permission = update.permission as { can: { role: string } | false; rawParams: Record<string, unknown> };
      if (kind === 'denied') permission.can = false;
      if (kind === 'role') (permission.can as { role: string }).role = 'other';
      if (kind === 'action') update.action.actionName = 'add';
      if (kind === 'resource') update.action.resourceName = 'documents';
      if (kind === 'database') Object.assign(update, { db: {} });
      if (kind === 'filtered') permission.rawParams.filter = {};
      if (kind === 'locator') permission.rawParams.filterByTk = 101;
      await expect(
        handler.handle(
          ctx,
          actor(),
          async () => source,
          async () => update,
          async () => read,
        ),
      ).rejects.toThrow();
      expect(await linked()).toEqual([105]);
    },
  );
  it.each(['denied', 'role', 'action', 'resource', 'database', 'filtered', 'locator'])(
    'rejects invalid source decisions before child writes %s',
    async (kind) => {
      const ctx = await association();
      const source = await context('documents', 'add');
      const permission = source.permission as { can: { role: string } | false; rawParams: Record<string, unknown> };
      if (kind === 'denied') permission.can = false;
      if (kind === 'role') (permission.can as { role: string }).role = 'other';
      if (kind === 'action') source.action.actionName = 'update';
      if (kind === 'resource') source.action.resourceName = 'children';
      if (kind === 'database') Object.assign(source, { db: {} });
      if (kind === 'filtered') permission.rawParams.filter = {};
      if (kind === 'locator') permission.rawParams.filterByTk = 3;
      const update = vi.fn(async () => null);
      await expect(
        handler.handle(
          ctx,
          actor(),
          async () => source,
          update,
          async () => null,
        ),
      ).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
      expect(ctx.body).toBe('unchanged');
      expect(await linked()).toEqual([105]);
    },
  );
  pg('intersects source role conditions with source ownership', async () => {
    await expect(run(await association(), { filter: { id: 4 } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await linked()).toEqual([105]);
  });
  pg('requires readable explicit targets even when a link would not change', async () => {
    await expect(
      run(await association('add', { values: [105] }), {}, {}, { filter: { id: 101 } }),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await expect(run(await association(), {}, {}, { fields: ['name'] })).rejects.toThrow();
    expect(await linked()).toEqual([105]);
  });
  pg('does not claim a legacy source on a no-op', async () => {
    const config = structuredClone((await store.read(mainIdentity))!);
    config.rules[0].condition = {
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    };
    await store.save(mainIdentity, config, { userId: 28 });
    const ctx = await association('set', { values: [] }, {}, '5');
    const source = await context('documents', 'set');
    const update = vi.fn(async () => null);
    const read = vi.fn(async () => null);
    await handler.handle(ctx, actor(), async () => source, update, read);
    expect(update).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect((await docs.model.findByPk(5))!.get('tenantId')).toBeNull();
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
  });
  pg('passes the original server context to actual child writes', async () => {
    const ctx = await association();
    const update = vi.spyOn(children.repository, 'update');
    await run(ctx);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ context: ctx }));
  });
  pg('accepts absent optional final permission values represented by undefined', async () => {
    const ctx = await association();
    const source = await context('documents', 'add');
    const update = await context('children', 'update');
    const read = await context('children', 'list');
    for (const entry of [source, update])
      Object.assign((entry.permission as { parsedParams: object }).parsedParams, {
        filter: undefined,
        whitelist: undefined,
        blacklist: undefined,
        own: undefined,
      });
    await handler.handle(
      ctx,
      actor(),
      async () => source,
      async () => update,
      async () => read,
    );
    expect(await linked()).toEqual([101, 105]);
  });
  it.each(['inverse', 'locator', 'sourceField'])('rejects asynchronous field and locator changes %s', async (kind) => {
    const ctx = await association();
    const source = await context('documents', 'add');
    await expect(
      handler.handle(
        ctx,
        actor(),
        async () => {
          if (kind === 'inverse') children.getField('document').target = 'children';
          if (kind === 'locator') children.options.filterTargetKey = 'name';
          if (kind === 'sourceField') docs.getField('children').target = 'documents';
          return source;
        },
        async () => null,
        async () => null,
      ),
    ).rejects.toThrow();
    expect(ctx.body).toBe('unchanged');
    expect(await linked()).toEqual([105]);
  });
  pg('claims historical sources and actual edited children together', async () => {
    for (const value of [mainIdentity, childIdentity]) {
      const config = structuredClone((await store.read(value))!);
      config.rules[0].condition = {
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      };
      await store.save(value, config, { userId: 28 });
    }
    await run(await association('add', { values: [104] }, {}, '5'));
    expect((await docs.model.findByPk(5))!.get('tenantId')).toBe('B');
    expect((await children.model.findByPk(104))!.get('tenantId')).toBe('B');
    expect((await children.model.findByPk(104))!.get('documentId')).toBe(5);
  });
  pg('captures actor, selectors and target operation before asynchronous source authorization', async () => {
    const ctx = await association();
    const source = await context('documents', 'add');
    const update = await context('children', 'update');
    const read = await context('children', 'list');
    const authenticated = actor();
    await handler.handle(
      ctx,
      authenticated,
      async () => {
        authenticated.tenantId = 'C';
        ctx.action.actionName = 'set';
        (ctx.permission as { rawParams: { values: number[] } }).rawParams.values = [103];
        return source;
      },
      async () => update,
      async () => read,
    );
    expect(await linked()).toEqual([101, 105]);
  });
  pg('rejects preparation ending during target update authorization', async () => {
    const ctx = await association();
    const source = await context('documents', 'add');
    const update = await context('children', 'update');
    const read = await context('children', 'list');
    await expect(
      handler.handle(
        ctx,
        actor(),
        async () => source,
        async () => {
          adapter.release(ctx);
          return update;
        },
        async () => read,
      ),
    ).rejects.toThrow();
    expect(await linked()).toEqual([105]);
  });
  pg('checks final persisted-query lifecycle before committing child writes', async () => {
    const ctx = await association();
    const source = await context('documents', 'add');
    const update = await context('children', 'update');
    const read = await context('children', 'list');
    const original = children.model.findAll.bind(children.model);
    vi.spyOn(children.model, 'findAll').mockImplementation(async (...args) => {
      const records = await original(...args);
      const options = args[0] as { transaction?: unknown; lock?: unknown; attributes?: unknown };
      if (options?.transaction && !options.lock && !options.attributes) adapter.release(ctx);
      return records;
    });
    await expect(
      handler.handle(
        ctx,
        actor(),
        async () => source,
        async () => update,
        async () => read,
      ),
    ).rejects.toThrow();
    expect(await linked()).toEqual([105]);
  });
});
