import { ACL, Resourcer, type Collection, type Database, type Model } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { AccessBelongsToService } from '../../access-control/belongs-to';
import { AccessBelongsToMutationHandler } from '../../access-control/belongs-to-mutation-handler';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessMutationService } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import { AccessReferenceService } from '../../access-control/references';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };
const customerIdentity = { ...mainIdentity, collectionKey: 'customers-key', collectionName: 'customers' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('finalized belongs-to mutations (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let customers: Collection | undefined;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessBelongsToMutationHandler;
  const auth = () => ({ tenantId: 'B', roleName: 'editor', userId: 28 });
  const identity = (collection: Collection) =>
    collection === docs ? mainIdentity : collection === customers ? customerIdentity : projectIdentity;
  const pg = (name: string, run: () => Promise<void>) => it.skipIf(dialect !== 'postgres')(name, run);

  beforeEach(async () => {
    customers = undefined;
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
        { name: 'occurredAt', type: 'date' },
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
    await adapter.prepare(ctx, [mainIdentity, projectIdentity, ...(customers ? [customerIdentity] : [])]);
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
  pg('saves scalar fields and a readable reference together using the old source role condition', async () => {
    const ctx = await context(
      'documents',
      'update',
      { values: { project: 101, name: 'Changed' } },
      { fields: ['project', 'name'], filter: { name: 'Owned' } },
    );
    await execute(ctx, { fields: ['id'] });
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    expect(await read()).toMatchObject({ name: 'Changed', projectId: 101, tenantId: 'B' });
    expect((await projects.model.findByPk(101))!.get('name')).toBe('Visible');
  });
  pg('filters scalar fields with finalized source whitelist and blacklist', async () => {
    for (const grant of [{ fields: ['project'] }, { blacklist: ['name'] }]) {
      const ctx = await context('documents', 'update', { values: { project: 101, name: 'Forbidden' } }, grant);
      await execute(ctx);
      expect(await read()).toMatchObject({ name: 'Owned', projectId: 101 });
    }
  });
  pg('edits scalars without rereading an unchanged hidden reference', async () => {
    await docs.model.update({ projectId: 102 }, { where: { id: 3 } });
    const ctx = await context('documents', 'update', { values: { project: 102, name: 'Changed' } });
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, auth(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({ name: 'Changed', projectId: 102 });
  });
  pg('does not persist scalar edits when the new reference is denied', async () => {
    const ctx = await context('documents', 'update', { values: { project: 102, name: 'Changed' } });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await read()).toMatchObject({ name: 'Owned', projectId: 103 });
    expect(ctx.body).toBe('unchanged');
  });
  pg('rolls back scalar edits and references when a repository hook fails', async () => {
    const ctx = await context('documents', 'update', { values: { project: 101, name: 'Changed' } });
    const error = new Error('mixed hook failure');
    db.on('documents.afterUpdate', async () => {
      throw error;
    });
    await expect(execute(ctx)).rejects.toBe(error);
    expect(await read()).toMatchObject({ name: 'Owned', projectId: 103 });
  });
  pg('retains managed ownership validation even when field grants exclude tenantId', async () => {
    const ctx = await context(
      'documents',
      'update',
      { values: { project: 101, name: 'Changed', tenantId: 'C' } },
      { fields: ['project', 'name'] },
    );
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    expect(await read()).toMatchObject({ name: 'Owned', projectId: 103, tenantId: 'B' });
  });
  pg('claims a historical source only with the successful mixed update', async () => {
    const config = configFor({
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity))!.revision }, { userId: 28 });
    const ctx = await context('documents', 'update', {
      filterByTk: 5,
      values: { project: 104, name: 'Claimed', tenantId: null },
    });
    await execute(ctx);
    expect(await read(5)).toMatchObject({ name: 'Claimed', projectId: 104, tenantId: 'B' });
    expect((await projects.model.findByPk(104))!.get('tenantId')).toBeNull();
  });
  pg('rolls back the whole mixed edit on metadata drift after persistence', async () => {
    const ctx = await context('documents', 'update', { values: { project: 101, name: 'Changed' } });
    db.on('documents.afterUpdate', async () => {
      docs.options.filterTargetKey = 'projectId';
    });
    await expect(execute(ctx)).rejects.toThrow('locator changed');
    expect(await read()).toMatchObject({ name: 'Owned', projectId: 103 });
  });
  pg('does not claim historical data when filtered scalars and the reference make no change', async () => {
    const config = configFor({
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity))!.revision }, { userId: 28 });
    for (const grant of [{ fields: ['project'] }, { fields: ['project', 'name'] }]) {
      const ctx = await context(
        'documents',
        'update',
        { filterByTk: 5, values: { project: 103, name: 'Legacy', tenantId: null } },
        grant,
      );
      await execute(ctx);
      expect(await read(5)).toMatchObject({ tenantId: null, name: 'Legacy', projectId: 103 });
      expect(ctx.body).toEqual({ keys: [], affected: 0 });
    }
  });
  pg('allows an authorized mixed update to leave its old ownership condition', async () => {
    const config = configFor({
      type: 'all',
      children: [
        ownerCondition,
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: 'Owned' },
        },
      ],
    });
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity))!.revision }, { userId: 28 });
    const ctx = await context('documents', 'update', { values: { project: 101, name: 'Changed' } });
    await execute(ctx);
    expect(await read()).toMatchObject({ name: 'Changed', projectId: 101, tenantId: 'B' });
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
  });
  pg('does not claim a historical source when a date is resubmitted as its JSON string', async () => {
    const config = configFor({
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity))!.revision }, { userId: 28 });
    const date = '2026-10-20T00:00:00.000Z';
    await docs.model.update({ occurredAt: date }, { where: { id: 5 } });
    const ctx = await context('documents', 'update', { filterByTk: 5, values: { project: 103, occurredAt: date } });
    await execute(ctx);
    expect(await read(5)).toMatchObject({ tenantId: null, occurredAt: new Date(date) });
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
  });
  for (const kind of ['attribute', 'model']) {
    pg(`does not invoke ${kind} setters while predicting a mixed no-op`, async () => {
      const config = configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      });
      await store.save(
        mainIdentity,
        { ...config, revision: (await store.read(mainIdentity))!.revision },
        { userId: 28 },
      );
      const setter = vi.fn(function (this: Model, value: unknown) {
        this.setDataValue('name', `${value}!`);
      });
      if (kind === 'attribute') docs.model.rawAttributes.name.set = setter;
      else docs.model.options.setterMethods = { name: setter };
      docs.model.refreshAttributes();
      await docs.repository.update({ filterByTk: 3, values: { name: 'Legacy', projectId: 103 } });
      const normalCalls = setter.mock.calls.length;
      const normalName = (await read()).name;
      setter.mockClear();
      const ctx = await context('documents', 'update', { filterByTk: 5, values: { project: 103, name: 'Legacy' } });
      await execute(ctx);
      expect(setter).toHaveBeenCalledTimes(normalCalls);
      expect(await read(5)).toMatchObject({ tenantId: 'B', name: normalName, projectId: 103 });
    });
  }
  pg('uses the captured mixed patch and identity across asynchronous target authorization', async () => {
    const ctx = await context('documents', 'update', { values: { project: 101, name: 'Changed' } });
    const related = await target();
    const actor = auth();
    await handler.handle(ctx, actor, async () => {
      const permission = ctx.permission as { rawParams: { values: object }; parsedParams: object };
      Object.assign(permission.rawParams.values, { project: 102, name: 'Tampered', tenantId: 'C' });
      Object.assign(permission.parsedParams, { blacklist: ['name', 'project'] });
      actor.tenantId = 'C';
      return related;
    });
    expect(await read()).toMatchObject({ name: 'Changed', projectId: 101, tenantId: 'B' });
  });
  pg('rolls back a historical mixed claim when a repository hook fails', async () => {
    const config = configFor({
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity))!.revision }, { userId: 28 });
    const ctx = await context('documents', 'update', { filterByTk: 5, values: { project: 104, name: 'Claimed' } });
    const error = new Error('claim hook failure');
    db.on('documents.afterUpdate', async () => {
      throw error;
    });
    await expect(execute(ctx)).rejects.toBe(error);
    expect(await read(5)).toMatchObject({ tenantId: null, name: 'Legacy', projectId: 103 });
    expect(ctx.body).toBe('unchanged');
  });
  pg('saves two independently authorized references and scalar fields atomically', async () => {
    docs.setField('otherProject', { type: 'belongsTo', target: 'projects', foreignKey: 'otherProjectId' });
    await docs.model.sync({ alter: true });
    const ctx = await context('documents', 'update', { values: { project: 101, otherProject: 103, name: 'Changed' } });
    const authorize = vi.fn(() => target({ fields: ['id'] }));
    await handler.handle(ctx, auth(), authorize);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B', projectId: 101, otherProjectId: 103 });
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
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
    { values: { project: 101, projectId: 102 } },
    { values: { project: 101, unknown: 'edit' } },
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
  it('rejects the 21st submitted reference before SQL or target authorization', async () => {
    const values: Record<string, number> = { project: 101 };
    for (let index = 0; index < 20; index++) {
      const name = `project${index}`;
      docs.setField(name, { type: 'belongsTo', target: 'projects', foreignKey: `projectId${index}` });
      values[name] = 103;
    }
    const ctx = await context('documents', 'update', { values });
    const decision = vi.fn(async () => null);
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(ctx, auth(), decision)).rejects.toThrow(/between 1 and 20/i);
    expect(sql).not.toHaveBeenCalled();
    expect(decision).not.toHaveBeenCalled();
  });
  it('rejects mixed relationship types before SQL or target authorization', async () => {
    docs.setField('children', { type: 'hasMany', target: 'projects', foreignKey: 'documentId' });
    const ctx = await context('documents', 'update', { values: { project: 101, children: [103] } });
    const decision = vi.fn(async () => null);
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(ctx, auth(), decision)).rejects.toThrow(/only BelongsTo/i);
    expect(sql).not.toHaveBeenCalled();
    expect(decision).not.toHaveBeenCalled();
  });

  describe.skipIf(dialect !== 'postgres')('multiple references', () => {
    beforeEach(async () => {
      customers = db.collection({
        name: 'customers',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'tenantId', type: 'string' },
          { name: 'name', type: 'string' },
        ],
      });
      await customers.model.sync();
      await customers.model.bulkCreate([
        { id: 201, tenantId: 'H', name: 'Visible' },
        { id: 202, tenantId: 'C', name: 'Hidden' },
        { id: 203, tenantId: 'B', name: 'Owned' },
        { id: 204, tenantId: null, name: 'Legacy' },
      ]);
      docs.setField('customer', { type: 'belongsTo', target: 'customers', foreignKey: 'customerId' });
      await docs.model.sync({ alter: true });
      await docs.model.update({ customerId: 203 }, { where: {} });
      await db.getRepository('collections').create({ values: { key: 'customers-key', name: 'customers' } });
      await store.save(customerIdentity, { ...(await store.read(projectIdentity))!, revision: 0 }, { userId: 28 });
    });
    const multipleContext = (values: object = { name: 'Changed', project: 101, customer: 201 }, grant: object = {}) =>
      context('documents', 'update', { values }, grant);
    const authorize = (collection: Collection) => context(collection.name, 'list', {}, { fields: ['id'] });
    const allowLegacyEditing = async () => {
      const config = configFor({
        type: 'any',
        children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      });
      await store.save(
        mainIdentity,
        { ...config, revision: (await store.read(mainIdentity))!.revision },
        { userId: 28 },
      );
    };

    it('checks independent targets and filters scalar input using finalized field grants', async () => {
      const ctx = await multipleContext(undefined, { fields: ['project', 'customer'] });
      const decision = vi.fn(authorize);
      await handler.handle(ctx, auth(), decision);
      expect(decision.mock.calls.map(([collection]) => collection.name)).toEqual(['projects', 'customers']);
      expect(await read()).toMatchObject({ tenantId: 'B', name: 'Owned', projectId: 101, customerId: 201 });
      expect((await projects.model.findByPk(101))!.get('tenantId')).toBe('H');
      expect((await customers!.model.findByPk(201))!.get('tenantId')).toBe('H');
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    });
    it('rejects all scalar and reference edits when the second target is hidden', async () => {
      const ctx = await multipleContext({ name: 'Changed', project: 101, customer: 202 });
      await expect(handler.handle(ctx, auth(), authorize)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await read()).toMatchObject({ name: 'Owned', projectId: 103, customerId: 203 });
      expect(ctx.body).toBe('unchanged');
    });
    it('applies the second relationship scope independently of its readable target', async () => {
      (docs.model.associations.customer as typeof docs.model.associations.customer & { scope: object }).scope = {
        name: 'Owned',
      };
      const ctx = await multipleContext();
      await expect(handler.handle(ctx, auth(), authorize)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await read()).toMatchObject({ name: 'Owned', projectId: 103, customerId: 203 });
    });
    it('saves exactly 20 independently authorized references', async () => {
      const values: Record<string, number> = { project: 101, customer: 201 };
      const expected: Record<string, number> = { projectId: 101, customerId: 201 };
      for (let index = 0; index < 18; index++) {
        const name = `project${index}`;
        const foreignKey = `projectId${index}`;
        docs.setField(name, { type: 'belongsTo', target: 'projects', foreignKey });
        values[name] = index % 2 === 0 ? 101 : 103;
        expected[foreignKey] = values[name];
      }
      await docs.model.sync({ alter: true });
      const ctx = await multipleContext(values, { fields: Object.keys(values) });
      const decision = vi.fn(authorize);
      await handler.handle(ctx, auth(), decision);
      expect(decision).toHaveBeenCalledTimes(20);
      expect(await read()).toMatchObject({ tenantId: 'B', ...expected });
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    });
    it('does not borrow the first target role condition for the second', async () => {
      const ctx = await multipleContext();
      await expect(
        handler.handle(ctx, auth(), (collection) =>
          context(
            collection.name,
            'list',
            {},
            { fields: ['id'], filter: { name: collection === projects ? 'Visible' : 'Owned' } },
          ),
        ),
      ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await read()).toMatchObject({ name: 'Owned', projectId: 103, customerId: 203 });
    });
    it.each(['denied', 'hidden key', 'wrong role', 'filtered lookup'])(
      'requires an independent final second target grant: %s',
      async (kind) => {
        const ctx = await multipleContext();
        await expect(
          handler.handle(ctx, auth(), async (collection) => {
            if (collection === projects) return authorize(collection);
            if (kind === 'denied') return null;
            const related = await context(
              collection.name,
              'list',
              kind === 'filtered lookup' ? { filter: { id: 201 } } : {},
              { fields: kind === 'hidden key' ? ['name'] : ['id'] },
            );
            if (kind === 'wrong role') (related.permission as { can: { role: string } }).can.role = 'other';
            return related;
          }),
        ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(await read()).toMatchObject({ name: 'Owned', projectId: 103, customerId: 203 });
        expect(ctx.body).toBe('unchanged');
      },
    );
    it.each([{ fields: ['project', 'name'] }, { blacklist: ['customerId'] }, { blacklist: ['customer'] }])(
      'requires source permission for every submitted reference: %j',
      async (grant) => {
        const ctx = await multipleContext(undefined, grant);
        const decision = vi.fn(authorize);
        await expect(handler.handle(ctx, auth(), decision)).rejects.toThrow(/field is not authorized/i);
        expect(decision).not.toHaveBeenCalled();
        expect(await read()).toMatchObject({ name: 'Owned', projectId: 103, customerId: 203 });
      },
    );
    it('retains unchanged hidden references while editing a scalar field', async () => {
      await docs.model.update({ projectId: 102, customerId: 202 }, { where: { id: 3 } });
      const ctx = await multipleContext({ name: 'Changed', project: 102, customer: 202 });
      const decision = vi.fn(async () => null);
      await handler.handle(ctx, auth(), decision);
      expect(decision).not.toHaveBeenCalled();
      expect(await read()).toMatchObject({ name: 'Changed', projectId: 102, customerId: 202 });
    });
    it('clears hidden references without requiring old target read permission', async () => {
      await docs.model.update({ projectId: 102, customerId: 202 }, { where: { id: 3 } });
      const ctx = await multipleContext({ project: null, customer: null });
      const decision = vi.fn(async () => null);
      await handler.handle(ctx, auth(), decision);
      expect(decision).not.toHaveBeenCalled();
      expect(await read()).toMatchObject({ projectId: null, customerId: null });
    });
    it('checks only the changed non-null second reference when the first is cleared', async () => {
      const ctx = await multipleContext({ project: null, customer: 201 });
      const decision = vi.fn(authorize);
      await handler.handle(ctx, auth(), decision);
      expect(decision.mock.calls.map(([collection]) => collection.name)).toEqual(['customers']);
      expect(await read()).toMatchObject({ projectId: null, customerId: 201 });
    });
    it('uses the old source role condition and permits a successful edit to leave it', async () => {
      const ctx = await multipleContext(undefined, {
        filter: { project: { name: 'Owned' }, customer: { name: 'Owned' } },
      });
      await handler.handle(ctx, auth(), authorize);
      expect(await read()).toMatchObject({ name: 'Changed', projectId: 101, customerId: 201 });
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    });
    it('does not borrow source visibility to grant update', async () => {
      const ctx = await context('documents', 'update', { filterByTk: 1, values: { project: 101, customer: 201 } });
      const decision = vi.fn(authorize);
      await expect(handler.handle(ctx, auth(), decision)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(decision).not.toHaveBeenCalled();
      expect(await read(1)).toMatchObject({ projectId: 103, customerId: 203 });
    });
    it('claims only a changed historical source and never its historical targets', async () => {
      await allowLegacyEditing();
      const ctx = await context('documents', 'update', {
        filterByTk: 5,
        values: { project: 104, customer: 204, name: 'Claimed' },
      });
      await handler.handle(ctx, auth(), authorize);
      expect(await read(5)).toMatchObject({ name: 'Claimed', tenantId: 'B', projectId: 104, customerId: 204 });
      expect((await projects.model.findByPk(104))!.get('tenantId')).toBeNull();
      expect((await customers!.model.findByPk(204))!.get('tenantId')).toBeNull();
    });
    it('does not write or claim an unchanged historical source', async () => {
      await allowLegacyEditing();
      const ctx = await context('documents', 'update', {
        filterByTk: 5,
        values: { project: 103, customer: 203, name: 'Legacy' },
      });
      const decision = vi.fn(async () => null);
      const write = vi.spyOn(docs.repository, 'update');
      await handler.handle(ctx, auth(), decision);
      expect(write).not.toHaveBeenCalled();
      expect(decision).not.toHaveBeenCalled();
      expect(await read(5)).toMatchObject({ tenantId: null, name: 'Legacy', projectId: 103, customerId: 203 });
      expect(ctx.body).toEqual({ keys: [], affected: 0 });
    });
    it('keeps historical sources read-only without G', async () => {
      const ctx = await context('documents', 'update', { filterByTk: 5, values: { project: 104, customer: 204 } });
      await expect(handler.handle(ctx, auth(), authorize)).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
      expect(await read(5)).toMatchObject({ tenantId: null, projectId: 103, customerId: 203 });
    });
    it('preserves all captured input and identity across the first target decision', async () => {
      const ctx = await multipleContext();
      const actor = auth();
      await handler.handle(ctx, actor, async (collection) => {
        actor.tenantId = 'C';
        (ctx.permission as { rawParams: { values: object } }).rawParams.values = {
          name: 'Tampered',
          project: 102,
          customer: 202,
        };
        return authorize(collection);
      });
      expect(await read()).toMatchObject({ name: 'Changed', tenantId: 'B', projectId: 101, customerId: 201 });
    });
    it('captures later metadata before awaiting the first target decision', async () => {
      const ctx = await multipleContext();
      const decision = vi.fn(async (collection: Collection) => {
        docs.model.associations.customer = { ...docs.model.associations.customer } as never;
        return authorize(collection);
      });
      await expect(handler.handle(ctx, auth(), decision)).rejects.toThrow(/association|metadata/i);
      expect(decision).toHaveBeenCalledTimes(1);
      expect(await read()).toMatchObject({ name: 'Owned', projectId: 103, customerId: 203 });
    });
    it('rechecks earlier metadata after authorizing the later target', async () => {
      const ctx = await multipleContext();
      await expect(
        handler.handle(ctx, auth(), async (collection) => {
          if (collection === customers)
            docs.model.associations.project = { ...docs.model.associations.project } as never;
          return authorize(collection);
        }),
      ).rejects.toThrow(/association|metadata/i);
      expect(await read()).toMatchObject({ name: 'Owned', projectId: 103, customerId: 203 });
    });
    it('rolls back the claim and all fields when a hook changes the second authorized FK', async () => {
      await allowLegacyEditing();
      const ctx = await context('documents', 'update', {
        filterByTk: 5,
        values: { name: 'Claimed', project: 101, customer: 201 },
      });
      docs.model.addHook('beforeUpdate', 'second-reference', (record) => record.setDataValue('customerId', 203));
      await expect(handler.handle(ctx, auth(), authorize)).rejects.toThrow(/authorized foreign key/i);
      expect(await read(5)).toMatchObject({ tenantId: null, name: 'Legacy', projectId: 103, customerId: 203 });
      expect(ctx.body).toBe('unchanged');
    });
    it('rolls back all fields when a hook changes an unrelated relationship key', async () => {
      docs.setField('otherProject', { type: 'belongsTo', target: 'projects', foreignKey: 'otherProjectId' });
      await docs.model.sync({ alter: true });
      const ctx = await multipleContext();
      docs.model.addHook('beforeUpdate', 'unrelated-reference', (record) => record.setDataValue('otherProjectId', 101));
      await expect(handler.handle(ctx, auth(), authorize)).rejects.toThrow(/protected relationship key/i);
      expect(await read()).toMatchObject({ name: 'Owned', projectId: 103, customerId: 203, otherProjectId: null });
    });
    it('rolls back repository errors without publishing afterCommit notifications', async () => {
      const ctx = await multipleContext();
      const notification = vi.fn();
      const error = new Error('multiple reference hook failure');
      db.on('documents.afterUpdate', async (_record, options) => {
        options.transaction.afterCommit(notification);
        throw error;
      });
      await expect(handler.handle(ctx, auth(), authorize)).rejects.toBe(error);
      expect(notification).not.toHaveBeenCalled();
      expect(await read()).toMatchObject({ name: 'Owned', projectId: 103, customerId: 203 });
    });
    it.each([{ customer: { id: 201 } }, { customer: [201] }, { customer: 201, customerId: 202 }])(
      'rejects nested and raw second reference values before SQL: %j',
      async (invalid) => {
        const ctx = await multipleContext({ project: 101, ...invalid });
        const decision = vi.fn(authorize);
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(handler.handle(ctx, auth(), decision)).rejects.toThrow();
        expect(decision).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
      },
    );
    it.each(['null', 'empty', 'duplicate', 'sparse', 'oversized'])(
      'rejects an invalid trusted reference list before invoking the writer: %s',
      async (kind) => {
        const ctx = await multipleContext();
        const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
        const service = new AccessBelongsToService(
          db,
          adapter,
          queries,
          new AccessMutationService(db, adapter, queries),
          new AccessReferenceService(db, adapter, queries),
        );
        const reference = { association: 'project', target: projectIdentity, targetKey: 101 };
        const sparse = [reference, reference];
        delete sparse[1];
        const references =
          kind === 'null'
            ? null
            : kind === 'empty'
              ? []
              : kind === 'duplicate'
                ? [reference, reference]
                : kind === 'sparse'
                  ? sparse
                  : Array(21).fill(reference);
        const writer = vi.fn(async () => {});
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(
          service.withReferences(ctx, mainIdentity, auth(), { sourceKeys: [3], references }, writer),
        ).rejects.toThrow();
        expect(writer).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
      },
    );
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
