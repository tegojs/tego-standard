import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { AccessBelongsToMutationHandler } from '../../access-control/belongs-to-mutation-handler';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('finalized belongs-to mutations (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessBelongsToMutationHandler;
  const auth = () => ({ tenantId: 'B', roleName: 'editor', userId: 28 });
  const identity = (collection: Collection) => (collection === docs ? mainIdentity : projectIdentity);
  const pg = (name: string, run: () => Promise<void>) => it.skipIf(dialect !== 'postgres')(name, run);

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'projectId', type: 'integer' },
      ],
    });
    projects = db.collection({
      name: 'projects',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
      ],
    });
    await projects.model.sync();
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    await docs.model.sync();
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
    await tenants.model.create({ id: 'B', enabled: true });
    await projects.model.bulkCreate([
      { id: 101, tenantId: 'H', name: 'Visible' },
      { id: 102, tenantId: 'C', name: 'Hidden' },
      { id: 103, tenantId: 'B', name: 'Owned' },
      { id: 104, tenantId: null, name: 'Legacy' },
    ]);
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'H', name: 'Visible', projectId: 103 },
      { id: 3, tenantId: 'B', name: 'Owned', projectId: 103 },
      { id: 5, tenantId: null, name: 'Legacy', projectId: 103 },
    ]);
    await db.getRepository('collections').create({ values: { key: 'projects-key', name: 'projects' } });
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    for (const key of [mainIdentity, projectIdentity]) {
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
                right: { type: 'literal', value: 'Visible' },
              },
              { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
            ],
          },
          'visibility',
        ).rules[0],
        id: 'visible',
      });
      await store.save(key, { ...config, revision: 0 }, { userId: 28 });
    }
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    handler = new AccessBelongsToMutationHandler(
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

  async function context(resourceName = 'documents', actionName = 'update', params: object = {}, grant: object = {}) {
    const acl = new ACL();
    acl.setAvailableAction('update', {});
    acl.setAvailableAction('list', {});
    acl.define({ role: 'editor' }).grantAction(`${resourceName}:${actionName}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: resourceName, actions: { update: {}, list: {} } });
    const action = resourcer.getAction(resourceName, actionName).clone();
    Object.assign(action, { resourceName, actionName, sourceId: undefined, resourceOf: undefined });
    action.mergeParams({
      resourceName,
      actionName,
      ...(actionName === 'update' ? { filterByTk: 3, values: { project: 101 } } : {}),
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
    await adapter.prepare(ctx, [mainIdentity, projectIdentity]);
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  const read = async (id = 3) => (await docs.model.findByPk(id))!.get();
  const target = (grant = {}, params = {}) => context('projects', 'list', params, grant);
  const execute = async (ctx: Awaited<ReturnType<typeof context>>, grant = {}, params = {}) => {
    const related = await target(grant, params);
    return handler.handle(ctx, auth(), async () => related);
  };

  pg('references a visible-only target without changing or claiming it', async () => {
    const ctx = await context('documents', 'update', {}, { fields: ['project'] });
    await execute(ctx, { fields: ['id'], filter: { name: 'Visible' } });
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    expect(await read()).toMatchObject({ projectId: 101, tenantId: 'B', name: 'Owned' });
    expect((await projects.model.findByPk(101))!.get()).toMatchObject({ tenantId: 'H', name: 'Visible' });
  });
  pg('references legacy targets without claiming them', async () => {
    await execute(await context('documents', 'update', { values: { project: 104 } }));
    expect((await read()).projectId).toBe(104);
    expect((await projects.model.findByPk(104))!.get('tenantId')).toBeNull();
  });
  pg('claims only a historical source whose ownership rule permits editing', async () => {
    const config = configFor({
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity))!.revision }, { userId: 28 });
    const ctx = await context('documents', 'update', { filterByTk: 5, values: { project: 104 } });
    await execute(ctx);
    expect(await read(5)).toMatchObject({ tenantId: 'B', projectId: 104 });
    expect((await projects.model.findByPk(104))!.get('tenantId')).toBeNull();
  });
  pg('keeps historical sources read-only without an ownership grant', async () => {
    const ctx = await context('documents', 'update', { filterByTk: 5 });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
    expect(await read(5)).toMatchObject({ tenantId: null, projectId: 103 });
  });
  pg('rejects target decisions that hide the key or originate from a filtered lookup', async () => {
    for (const [grant, params] of [
      [{ fields: ['name'] }, {}],
      [{}, { filter: { name: 'Visible' } }],
    ]) {
      await expect(execute(await context(), grant, params)).rejects.toThrow();
      expect((await read()).projectId).toBe(103);
    }
  });
  pg('uses independent association role facts for target reads without exposing their payload', async () => {
    projects.setField('documents', { type: 'hasMany', target: 'documents', foreignKey: 'projectId' });
    const ctx = await context('documents', 'update', { values: { project: 103 } });
    await docs.model.update({ projectId: 101 }, { where: { id: 3 } });
    await docs.model.create({ id: 7, tenantId: 'C', name: 'Hidden fact', projectId: 103 });
    await execute(ctx, { fields: ['id'], filter: { documents: { name: 'Hidden fact' } } });
    expect((await read()).projectId).toBe(103);
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
  });
  pg('unlinks without requiring permission to read the old target', async () => {
    await docs.model.update({ projectId: 102 }, { where: { id: 3 } });
    const authorize = vi.fn(async () => null);
    const ctx = await context('documents', 'update', { values: { project: null } });
    await handler.handle(ctx, auth(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect((await read()).projectId).toBeNull();
  });
  pg('does not treat an unchanged hidden target as a new reference', async () => {
    await docs.model.update({ projectId: 102 }, { where: { id: 3 } });
    const authorize = vi.fn(async () => null);
    const ctx = await context('documents', 'update', { values: { project: 102 } });
    await handler.handle(ctx, auth(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect((await read()).projectId).toBe(102);
  });
  pg('does not let visibility authorize writing a source', async () => {
    const ctx = await context('documents', 'update', { filterByTk: 1 });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect((await read(1)).projectId).toBe(103);
    expect(ctx.body).toBe('unchanged');
  });
  pg('requires target visibility independently from source ownership', async () => {
    await expect(execute(await context('documents', 'update', { values: { project: 102 } }))).rejects.toThrow();
    expect((await read()).projectId).toBe(103);
  });
  pg('applies final source role conditions', async () => {
    const ctx = await context('documents', 'update', {}, { filter: { name: 'Other' } });
    ctx.action.mergeParams({ filter: {} });
    await expect(execute(ctx)).rejects.toThrow();
    expect((await read()).projectId).toBe(103);
  });
  pg('applies independently resolved target role conditions', async () => {
    const ctx = await context();
    await expect(execute(ctx, { filter: { name: '{{ ctx.state.currentUser.name }}' } })).rejects.toThrow();
    expect((await read()).projectId).toBe(103);
  });
  pg('rejects target operation denial and foreign role decisions', async () => {
    for (const can of [false, { resource: 'projects', action: 'list', role: 'other' }]) {
      const ctx = await context();
      const related = await target();
      (related.permission as { can: unknown }).can = can;
      await expect(handler.handle(ctx, auth(), async () => related)).rejects.toThrow();
      expect(ctx.body).toBe('unchanged');
    }
    expect((await read()).projectId).toBe(103);
  });
  pg('rolls back repository hook failures', async () => {
    const ctx = await context();
    const error = new Error('hook failure');
    db.on('documents.afterUpdate', async () => {
      throw error;
    });
    await expect(execute(ctx)).rejects.toBe(error);
    expect((await read()).projectId).toBe(103);
  });
  pg('rejects metadata drift after the final persisted query', async () => {
    const ctx = await context();
    const related = await target();
    const original = docs.model.findAll.bind(docs.model);
    vi.spyOn(docs.model, 'findAll').mockImplementation(async (...args) => {
      const rows = await original(...args);
      if ((args[0] as { hooks?: boolean } | undefined)?.hooks === false && rows[0]?.getDataValue('projectId') === 101)
        docs.options.filterTargetKey = 'projectId';
      return rows;
    });
    await expect(handler.handle(ctx, auth(), async () => related)).rejects.toThrow();
    expect(ctx.body).toBe('unchanged');
    expect((await read()).projectId).toBe(103);
  });
  pg('rejects identity drift during asynchronous target authorization', async () => {
    const ctx = await context();
    const related = await target();
    await expect(
      handler.handle(ctx, auth(), async () => {
        docs.options.filterTargetKey = 'projectId';
        return related;
      }),
    ).rejects.toThrow();
    expect((await read()).projectId).toBe(103);
  });

  it.each([{ fields: ['name'] }, { fields: ['projectId'] }, { whitelist: ['project'], blacklist: ['project'] }])(
    'rejects missing association field grant %j',
    async (grant) => {
      const ctx = await context('documents', 'update', {}, grant);
      await expect(execute(ctx)).rejects.toThrow();
      expect(ctx.body).toBe('unchanged');
      expect((await read()).projectId).toBe(103);
    },
  );
  it.each([
    { values: { project: { id: 101, name: 'edit' } } },
    { values: { project: [101] } },
    { values: { projectId: 101 } },
    { values: { project: 101, name: 'edit' } },
    { values: { project: 101, tenantId: 'C' } },
    { filter: {}, values: { project: 101 } },
    { appends: ['project'], values: { project: 101 } },
    { filterByTk: [3], values: { project: 101 } },
    { filterByTk: undefined, values: { project: 101 } },
    { resourceIndex: 1, values: { project: 101 } },
  ])('rejects unsupported inputs %j', async (params) => {
    const ctx = await context('documents', 'update', params);
    await expect(execute(ctx)).rejects.toThrow();
    expect(ctx.body).toBe('unchanged');
    expect((await read()).projectId).toBe(103);
  });
  it('does not run writes on unsupported dialects', async () => {
    if (dialect === 'postgres') return;
    const ctx = await context();
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    expect((await read()).projectId).toBe(103);
  });
  it.each(['role', 'operation', 'resource', 'database', 'phase'])('rejects mismatched %s context', async (kind) => {
    const ctx = await context();
    if (kind === 'role') (ctx.permission as { can: { role: string } }).can.role = 'other';
    if (kind === 'operation') Object.assign(ctx.action, { actionName: 'create' });
    if (kind === 'resource') Object.assign(ctx.action, { resourceName: 'projects' });
    if (kind === 'database') Object.assign(ctx, { db: {} });
    if (kind === 'phase') adapter.release(ctx);
    await expect(execute(ctx)).rejects.toThrow();
    expect(ctx.body).toBe('unchanged');
    expect((await read()).projectId).toBe(103);
  });
});
