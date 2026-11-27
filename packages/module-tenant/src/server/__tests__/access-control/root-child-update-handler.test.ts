import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessTargetForeignKeyMutationHandler } from '../../access-control/has-many-mutation-handler';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const childIdentity = { ...mainIdentity, collectionName: 'children', collectionKey: 'children-key' };

describe.skipIf(!postgresUrl).each(['HasMany', 'HasOne'] as const)('root child update (%s)', (type) => {
  let db: Database;
  let docs: Collection;
  let children: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessTargetForeignKeyMutationHandler;
  const name = type === 'HasMany' ? 'children' : 'child';
  const selection = (keys: number[]) => (type === 'HasMany' ? keys : (keys[0] ?? null));
  const identity = (collection: Collection) => (collection === docs ? mainIdentity : childIdentity);

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl!);
    await seedConfigStore(db);
    await seedAclScopes(db);
    const fields = [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'tenantId', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'note', type: 'string' },
    ];
    docs = db.collection({ name: 'documents', timestamps: false, fields });
    children = db.collection({
      name: 'children',
      timestamps: false,
      fields: [...fields, { name: 'documentId', type: 'integer', field: 'document_id' }],
    });
    docs.setField(name, {
      type: type === 'HasMany' ? 'hasMany' : 'hasOne',
      target: 'children',
      foreignKey: 'documentId',
    });
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
        { id: 3, tenantId: 'B', name: 'Owned' },
        { id: 4, tenantId: 'H', name: 'Shared' },
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
    handler = new AccessTargetForeignKeyMutationHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
      type,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await db.sequelize.drop({ cascade: true });
    } finally {
      await db.close();
    }
  });

  async function context(resourceName: string, actionName: string, params: object = {}, grant: object = {}) {
    const acl = new ACL();
    for (const action of ['update', 'list']) acl.setAvailableAction(action, {});
    acl.define({ role: 'editor' }).grantAction(`${resourceName}:${actionName}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: resourceName, actions: { update: {}, list: {} } });
    const action = resourcer.getAction(resourceName, actionName).clone();
    Object.assign(action, { resourceName, actionName });
    action.mergeParams({ resourceName, actionName, filterByTk: undefined, ...params });
    const ctx = {
      db,
      action,
      permission: undefined as unknown,
      body: 'unchanged' as unknown,
      state: { currentRole: 'editor', currentUser: { id: 28 } },
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
  const root = (values: object, grant = {}, key = 3) =>
    context('documents', 'update', { filterByTk: key, values }, grant);
  const run = async (ctx: Awaited<ReturnType<typeof context>>, updateGrant = {}, readGrant = {}) => {
    const update = await context('children', 'update', {}, updateGrant);
    const read = await context('children', 'list', {}, readGrant);
    return handler.handleRoot(
      ctx,
      { tenantId: 'B', roleName: 'editor', userId: 28 },
      async () => update,
      async () => read,
    );
  };
  const row = async (collection: Collection, id: number) => (await collection.model.findByPk(id))!.toJSON();
  async function editableLegacy() {
    for (const value of [mainIdentity, childIdentity]) {
      const config = structuredClone((await store.read(value))!);
      config.rules[0].condition = {
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      };
      await store.save(value, config, { userId: 28 });
    }
  }

  it('saves scalar fields and a replacement selection in one root update', async () => {
    const ctx = await root({ name: 'Changed', [name]: selection([101]) }, { fields: ['name', name] });
    await run(ctx, { fields: ['document'] }, { fields: ['id'] });
    expect(await row(docs, 3)).toMatchObject({ name: 'Changed', tenantId: 'B' });
    expect(await row(children, 101)).toMatchObject({ documentId: 3, tenantId: 'B' });
    expect((await row(children, 105)).documentId).toBeNull();
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
  });
  it('clears the selection and filters unauthorized scalar fields', async () => {
    const ctx = await root({ name: 'Changed', note: 'Denied', [name]: selection([]) }, { fields: ['name', name] });
    await run(ctx);
    expect(await row(docs, 3)).toMatchObject({ name: 'Changed', note: null });
    expect((await row(children, 105)).documentId).toBeNull();
  });
  it('saves scalars with unchanged readable references without requiring child write permission', async () => {
    await children.model.update({ tenantId: 'H', name: 'Shared' }, { where: { id: 105 } });
    const ctx = await root({ name: 'Changed', [name]: selection([105]) });
    await handler.handleRoot(
      ctx,
      { tenantId: 'B', roleName: 'editor' },
      async () => null,
      async () => context('children', 'list'),
    );
    expect((await row(docs, 3)).name).toBe('Changed');
    expect((await row(children, 105)).tenantId).toBe('H');
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
  });
  it.each([102, 103, 104])('rejects non-writable target %s before saving scalars', async (id) => {
    const ctx = await root({ name: 'Changed', [name]: selection([id]) });
    await expect(run(ctx)).rejects.toMatchObject({ code: expect.any(String) });
    expect((await row(docs, 3)).name).toBe('Owned');
    expect((await row(children, 105)).documentId).toBe(3);
    expect(ctx.body).toBe('unchanged');
  });
  it('applies child update role filters to implicit removals', async () => {
    const ctx = await root({ name: 'Changed', [name]: selection([101]) });
    await expect(run(ctx, { filter: { id: 101 } })).rejects.toMatchObject({ code: expect.any(String) });
    expect((await row(docs, 3)).name).toBe('Owned');
    expect((await row(children, 105)).documentId).toBe(3);
  });
  it.each([{ fields: ['name'] }, { blacklist: [name] }, { filter: { name: 'No match' } }])(
    'requires source relation permission and pre-edit role scope %j',
    async (grant) => {
      const ctx = await root({ name: 'Changed', [name]: selection([101]) }, grant);
      await expect(run(ctx)).rejects.toMatchObject({ code: expect.any(String) });
      expect((await row(docs, 3)).name).toBe('Owned');
    },
  );
  it('does not use source visibility as write permission', async () => {
    await expect(run(await root({ name: 'Changed', [name]: selection([101]) }, {}, 4))).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect((await row(docs, 4)).name).toBe('Shared');
  });
  it('permits a legitimate transition out of the old role filter', async () => {
    await run(await root({ name: 'Changed', [name]: selection([101]) }, { filter: { name: 'Owned' } }));
    expect((await row(docs, 3)).name).toBe('Changed');
  });
  it('rolls back source and children and suppresses notifications if a child hook fails', async () => {
    const notify = vi.fn();
    docs.model.addHook('afterUpdate', (_record, options) => options.transaction.afterCommit(notify));
    children.model.addHook('afterUpdate', () => {
      throw new Error('child failure');
    });
    const ctx = await root({ name: 'Changed', [name]: selection([101]) });
    await expect(run(ctx)).rejects.toThrow('child failure');
    expect((await row(docs, 3)).name).toBe('Owned');
    expect((await row(children, 101)).documentId).toBeNull();
    expect((await row(children, 105)).documentId).toBe(3);
    expect(notify).not.toHaveBeenCalled();
  });
  it('rejects ownership transfer in the source scalar patch', async () => {
    await expect(run(await root({ tenantId: 'C', [name]: selection([101]) }))).rejects.toMatchObject({
      code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN',
    });
    expect((await row(children, 105)).documentId).toBe(3);
  });
  it('claims editable legacy source on scalar change with an unchanged empty selection', async () => {
    await editableLegacy();
    const ctx = await root({ name: 'Changed', [name]: selection([]) }, {}, 5);
    await run(ctx);
    expect(await row(docs, 5)).toMatchObject({ name: 'Changed', tenantId: 'B' });
    expect(ctx.body).toEqual({ keys: [5], affected: 1 });
  });
  it('does not claim legacy source when neither scalars nor selection changed', async () => {
    await editableLegacy();
    const ctx = await root({ name: 'Legacy', tenantId: null, [name]: selection([]) }, {}, 5);
    await run(ctx);
    expect((await row(docs, 5)).tenantId).toBeNull();
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
  });
  it('claims only actually changed editable legacy children', async () => {
    await editableLegacy();
    await run(await root({ [name]: selection([104]) }));
    expect(await row(children, 104)).toMatchObject({ documentId: 3, tenantId: 'B' });
  });
  it.each([{ documentId: 4 }, { id: 4 }, { unknown: 'value' }])(
    'rejects unsupported source scalar writes %j',
    async (extra) => {
      await expect(run(await root({ ...extra, [name]: selection([101]) }))).rejects.toMatchObject({
        code: expect.any(String),
      });
      expect((await row(children, 105)).documentId).toBe(3);
    },
  );
  it('requires readable selected keys even for unchanged children', async () => {
    const ctx = await root({ name: 'Changed', [name]: selection([105]) });
    await expect(run(ctx, {}, { fields: ['name'] })).rejects.toMatchObject({ code: expect.any(String) });
    expect((await row(docs, 3)).name).toBe('Owned');
  });
  it('returns the stored source key for a string form locator', async () => {
    const ctx = await context('documents', 'update', { filterByTk: '3', values: { [name]: selection([101]) } });
    await run(ctx);
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
  });
  it('returns no change when unchanged scalars were filtered out', async () => {
    const ctx = await root({ name: 'Denied', [name]: selection([105]) }, { fields: [name] });
    await run(ctx);
    expect((await row(docs, 3)).name).toBe('Owned');
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
  });
  it.each([{}, { fields: ['name'] }, { blacklist: ['document'] }, { blacklist: ['documentId'] }])(
    'does not infer child field authorization from source grants %j',
    async (grant) => {
      if (!Object.keys(grant).length) grant = { fields: [] };
      const ctx = await root({ name: 'Changed', [name]: selection([101]) });
      await expect(run(ctx, grant)).rejects.toMatchObject({ code: expect.any(String) });
      expect((await row(docs, 3)).name).toBe('Owned');
    },
  );
  it('uses captured values and identity across asynchronous target authorization', async () => {
    const values = { name: 'Changed', [name]: selection([101]) };
    const ctx = await root(values);
    const actor = { tenantId: 'B', roleName: 'editor' };
    await handler.handleRoot(
      ctx,
      actor,
      async () => context('children', 'update'),
      async () => {
        actor.tenantId = 'C';
        (ctx.permission as { rawParams: { values: object } }).rawParams.values = {
          name: 'Injected',
          [name]: selection([103]),
        };
        return context('children', 'list');
      },
    );
    expect(await row(docs, 3)).toMatchObject({ name: 'Changed', tenantId: 'B' });
    expect((await row(children, 101)).documentId).toBe(3);
    expect((await row(children, 103)).documentId).toBeNull();
  });
  it('rejects metadata drift during target authorization before any save', async () => {
    const ctx = await root({ name: 'Changed', [name]: selection([101]) });
    await expect(
      handler.handleRoot(
        ctx,
        { tenantId: 'B', roleName: 'editor' },
        async () => context('children', 'update'),
        async () => {
          Object.defineProperty(sourceField(), 'target', { value: 'documents', configurable: true });
          return context('children', 'list');
        },
      ),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect((await row(docs, 3)).name).toBe('Owned');
  });
  const sourceField = () => docs.getField(name);
  it('rolls back historical claims when the target save fails', async () => {
    await editableLegacy();
    const ctx = await root({ name: 'Changed', [name]: selection([104]) }, {}, 5);
    children.model.addHook('afterUpdate', () => {
      throw new Error('claim failure');
    });
    await expect(run(ctx)).rejects.toThrow('claim failure');
    expect(await row(docs, 5)).toMatchObject({ name: 'Legacy', tenantId: null });
    expect(await row(children, 104)).toMatchObject({ documentId: null, tenantId: null });
  });
  it('rejects hooks that transfer the source owner', async () => {
    docs.model.addHook('beforeUpdate', (record) => record.set('tenantId', 'C'));
    await expect(run(await root({ name: 'Changed', [name]: selection([101]) }))).rejects.toMatchObject({
      code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN',
    });
    expect(await row(docs, 3)).toMatchObject({ name: 'Owned', tenantId: 'B' });
    expect((await row(children, 105)).documentId).toBe(3);
  });
  it('rejects source hooks that also write a child', async () => {
    docs.model.addHook('afterUpdate', async (_record, options) => {
      await children.model.update({ documentId: 3 }, { where: { id: 103 }, transaction: options.transaction });
    });
    await expect(run(await root({ name: 'Changed', [name]: selection([101]) }))).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect((await row(docs, 3)).name).toBe('Owned');
    expect((await row(children, 103)).documentId).toBeNull();
  });
  it('rejects wrong-role finalized child decisions', async () => {
    const ctx = await root({ name: 'Changed', [name]: selection([101]) });
    const update = await context('children', 'update');
    (update.permission as { can: { role: string } }).can.role = 'other';
    await expect(
      handler.handleRoot(
        ctx,
        { tenantId: 'B', roleName: 'editor' },
        async () => update,
        async () => context('children', 'list'),
      ),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect((await row(docs, 3)).name).toBe('Owned');
  });
  it.each(['nested', 'wrongType', 'missing', 'large'])('rejects unsupported selections: %s', async (kind) => {
    const values: Record<string, unknown> = { name: 'Changed' };
    if (kind !== 'missing')
      values[name] = kind === 'nested' ? { id: 101 } : kind === 'large' ? Array(1001).fill(101) : undefined;
    await expect(run(await root(values))).rejects.toMatchObject({ code: expect.any(String) });
    expect((await row(docs, 3)).name).toBe('Owned');
  });
  it('rejects sparse and subclassed arrays without evaluating array accessors', async () => {
    class Keys extends Array<number> {}
    const getter = vi.fn(() => 101);
    const withGetter = [101];
    Object.defineProperty(withGetter, '0', { get: getter });
    for (const value of [Array(1), new Keys(101), withGetter]) {
      const ctx = await root({ [name]: [] });
      (ctx.permission as { rawParams: { values: object } }).rawParams.values = { [name]: value };
      await expect(run(ctx)).rejects.toMatchObject({ code: expect.any(String) });
    }
    expect(getter).not.toHaveBeenCalled();
  });
});
