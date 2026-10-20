import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootMutationHandler } from '../../access-control/root-mutation-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionName: 'projects', collectionKey: 'projects-key' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('finalized reference creation (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessRootMutationHandler;
  const identity = (collection: Collection) => (collection === docs ? mainIdentity : projectIdentity);
  const auth = () => ({ tenantId: 'B', roleName: 'editor', userId: 28 });
  const pg = (name: string, run: () => Promise<void>) => it.skipIf(dialect !== 'postgres')(name, run);

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    projects = db.collection({
      name: 'projects',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
      ],
    });
    docs = db.collection({
      name: 'documents',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string', defaultValue: 'Draft' },
        { name: 'projectId', type: 'integer' },
      ],
    });
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await projects.model.sync();
    await docs.model.sync();
    await tenants.model.sync();
    await tenants.model.create({ id: 'B', enabled: true });
    await projects.model.bulkCreate([
      { id: 101, tenantId: 'H', name: 'Visible' },
      { id: 102, tenantId: 'C', name: 'Hidden' },
      { id: 103, tenantId: 'B', name: 'Owned' },
      { id: 104, tenantId: null, name: 'Legacy' },
    ]);
    await db.getRepository('collections').create({ values: { key: 'projects-key', name: 'projects' } });
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    const visible = configFor(ownerCondition);
    visible.rules.push({
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
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    await store.save(projectIdentity, { ...visible, revision: 0 }, { userId: 28 });
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

  async function context(resource = 'documents', operation = 'create', params: object = {}, grant: object = {}) {
    const acl = new ACL();
    acl.setAvailableAction('create', {});
    acl.setAvailableAction('list', {});
    acl.define({ role: 'editor' }).grantAction(`${resource}:${operation}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: resource, actions: { create: {}, list: {} } });
    const action = resourcer.getAction(resource, operation).clone();
    Object.assign(action, {
      resourceName: resource,
      actionName: operation,
      sourceId: undefined,
      resourceOf: undefined,
    });
    action.mergeParams({
      resourceName: resource,
      actionName: operation,
      ...(operation === 'create' ? { values: { name: 'Created', project: 101 } } : {}),
      ...params,
    });
    const ctx = {
      db,
      action,
      state: { currentRole: 'editor', currentUser: { id: 28 } },
      get: () => '+08:00',
      logger: { info: vi.fn() },
      throw: (status: number) => {
        throw new Error(String(status));
      },
      permission: undefined as unknown,
      body: 'unchanged' as unknown,
    };
    await adapter.prepare(ctx, [mainIdentity, projectIdentity]);
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  const rows = () => docs.model.findAll();
  const target = (grant = {}, params = {}) => context('projects', 'list', params, grant);
  const execute = async (ctx: Awaited<ReturnType<typeof context>>, grant = {}, params = {}) =>
    handler.handle(ctx, auth(), async (collection) => {
      expect(collection).toBe(projects);
      return target(grant, params);
    });

  pg('creates a record referencing a visibility-only target without changing that target', async () => {
    const ctx = await context('documents', 'create', {}, { fields: ['name', 'project'] });
    await execute(ctx, { fields: ['id'], filter: { name: 'Visible' } });
    expect(ctx.body).toEqual({ keys: [expect.any(Number)], affected: 1 });
    expect((await rows()).map((record) => record.get())).toMatchObject([
      { name: 'Created', tenantId: 'B', projectId: 101 },
    ]);
    expect((await projects.model.findByPk(101))!.get()).toMatchObject({ tenantId: 'H', name: 'Visible' });
  });

  pg('does not create a record when the selected target is hidden or excluded by the final list decision', async () => {
    const ctx = await context(
      'documents',
      'create',
      { values: { name: 'Hidden', project: 102 } },
      { fields: ['name', 'project'] },
    );
    await expect(execute(ctx, { fields: ['id'] })).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  pg('requires the target primary key to be readable', async () => {
    const ctx = await context('documents', 'create', {}, { fields: ['name', 'project'] });
    await expect(execute(ctx, { fields: ['name'], filter: { name: 'Visible' } })).rejects.toThrow(
      /key is not readable/i,
    );
    expect(await rows()).toEqual([]);
  });

  pg('rejects a readable target outside the registered association scope', async () => {
    const association = docs.model.associations.project as typeof docs.model.associations.project & { scope: object };
    association.scope = { name: 'Owned' };
    const ctx = await context();
    await expect(execute(ctx, { fields: ['id'] })).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
    expect((await projects.model.findByPk(101))!.get()).toMatchObject({ tenantId: 'H', name: 'Visible' });
  });

  pg('requires source create permission for the reference field', async () => {
    const ctx = await context('documents', 'create', {}, { fields: ['name'] });
    await expect(execute(ctx, { fields: ['id'], filter: { name: 'Visible' } })).rejects.toThrow(
      /reference field is not authorized/i,
    );
    expect(await rows()).toEqual([]);
  });

  pg('does not claim a visible legacy target when creating its reference', async () => {
    const ctx = await context(
      'documents',
      'create',
      { values: { name: 'Legacy reference', project: 104 } },
      { fields: ['name', 'project'] },
    );
    await execute(ctx, { fields: ['id'], filter: { tenantId: null } });
    expect((await rows()).map((record) => record.get())).toMatchObject([{ tenantId: 'B', projectId: 104 }]);
    expect((await projects.model.findByPk(104))!.get('tenantId')).toBeNull();
  });

  pg('allows a null reference without requesting target list authorization', async () => {
    const ctx = await context(
      'documents',
      'create',
      { values: { name: 'No project', project: null } },
      { fields: ['name', 'project'] },
    );
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, auth(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect((await rows()).map((record) => record.get())).toMatchObject([{ tenantId: 'B', projectId: null }]);
  });

  pg('rejects a raw foreign key even when the relation is also supplied', async () => {
    const ctx = await context(
      'documents',
      'create',
      { values: { name: 'Bad', project: 101, projectId: 103 } },
      { fields: ['name', 'project', 'projectId'] },
    );
    await expect(execute(ctx, { fields: ['id'], filter: { name: 'Visible' } })).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  pg('rolls back when a create hook changes the authorized reference target', async () => {
    const ctx = await context('documents', 'create', {}, { fields: ['name', 'project'] });
    docs.model.addHook('beforeCreate', 'change-reference-target', (record) => {
      record.setDataValue('projectId', 102);
    });
    await expect(execute(ctx, { fields: ['id'], filter: { name: 'Visible' } })).rejects.toThrow(/association values/i);
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  pg('applies independent target role restrictions even when G or V permits the target', async () => {
    const ctx = await context();
    await expect(execute(ctx, { fields: ['id'], filter: { name: 'Other' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await rows()).toEqual([]);
  });

  pg('does not borrow target visibility to grant source creation', async () => {
    const previous = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: previous.revision },
      { userId: 28 },
    );
    const ctx = await context();
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  pg('evaluates source role conditions using the actual inserted reference', async () => {
    const ctx = await context('documents', 'create', {}, { filter: { project: { name: 'Other' } } });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
  });

  pg('filters scalar input while retaining the authorized reference and defaults', async () => {
    const ctx = await context('documents', 'create', {}, { fields: ['project'] });
    await execute(ctx, { fields: ['id'] });
    expect((await rows()).map((record) => record.get())).toMatchObject([{ name: 'Draft', projectId: 101 }]);
  });

  pg('rejects a blacklisted physical foreign-key alias', async () => {
    const ctx = await context();
    Object.assign((ctx.permission as { parsedParams: object }).parsedParams, { blacklist: ['projectId'] });
    await expect(execute(ctx)).rejects.toThrow(/field is not authorized/i);
    expect(await rows()).toEqual([]);
  });

  pg('rejects a missing target before inserting the source', async () => {
    const ctx = await context('documents', 'create', { values: { project: 999 } });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await rows()).toEqual([]);
  });

  pg('captures the input and identity before asynchronous target authorization', async () => {
    const ctx = await context();
    const actor = auth();
    await handler.handle(ctx, actor, async () => {
      actor.tenantId = 'C';
      (ctx.permission as { rawParams: { values: object } }).rawParams.values = { project: 102, name: 'Injected' };
      return target({ fields: ['id'] });
    });
    expect((await rows()).map((record) => record.get())).toMatchObject([
      { tenantId: 'B', name: 'Created', projectId: 101 },
    ]);
  });

  pg('rejects preparation ending during asynchronous target authorization', async () => {
    const ctx = await context();
    await expect(
      handler.handle(ctx, auth(), async () => {
        adapter.release(ctx);
        return target({ fields: ['id'] });
      }),
    ).rejects.toThrow(/phase|prepared/i);
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  pg('rolls back reference metadata changes in a repository hook', async () => {
    const ctx = await context();
    docs.model.addHook('afterCreate', 'replace-relation', () => {
      docs.model.associations.project = { ...docs.model.associations.project } as never;
    });
    await expect(execute(ctx)).rejects.toThrow(/metadata|association/i);
    expect(await rows()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });

  pg('rolls back an unrelated relationship key introduced by a hook', async () => {
    docs.setField('otherProject', { type: 'belongsTo', target: 'projects', foreignKey: 'otherProjectId' });
    await docs.model.sync({ alter: true });
    const ctx = await context();
    docs.model.addHook('beforeCreate', 'other-relation', (record) => {
      record.setDataValue('otherProjectId', 102);
    });
    await expect(execute(ctx)).rejects.toThrow(/association values/i);
    expect(await rows()).toEqual([]);
  });

  pg('does not accept a target list grant for another role or a constrained lookup', async () => {
    for (const params of [{ filterByTk: 101 }, { filter: { id: 101 } }]) {
      const ctx = await context();
      await expect(execute(ctx, { fields: ['id'] }, params)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
      expect(await rows()).toEqual([]);
    }
    const ctx = await context();
    const related = await target({ fields: ['id'] });
    (related.permission as { can: { role: string } }).can.role = 'other';
    await expect(handler.handle(ctx, auth(), async () => related)).rejects.toThrow();
    expect(await rows()).toEqual([]);
  });

  it.each([{ project: { id: 101 } }, { project: [101] }, { project: true }, { project: 101, projectId: 102 }])(
    'rejects nested or raw reference values before SQL: %j',
    async (values) => {
      const ctx = await context('documents', 'create', { values });
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(handler.handle(ctx, auth(), async () => null)).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    },
  );

  it('rejects multiple references before SQL', async () => {
    docs.setField('otherProject', { type: 'belongsTo', target: 'projects', foreignKey: 'otherProjectId' });
    const ctx = await context('documents', 'create', { values: { project: 101, otherProject: 103 } });
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(ctx, auth(), async () => null)).rejects.toThrow(/exactly one/i);
    expect(sql).not.toHaveBeenCalled();
  });

  it('keeps scalar-only creation compatible when a target authorizer is provided', async () => {
    const ctx = await context('documents', 'create', { values: { name: 'Scalar only' } });
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, auth(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect((await rows()).map((record) => record.get())).toMatchObject([
      { name: 'Scalar only', tenantId: 'B', projectId: null },
    ]);
  });

  it.runIf(dialect === 'sqlite')('does not treat SQLite as verified relationship write support', async () => {
    const ctx = await context();
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    expect(await rows()).toEqual([]);
  });
});
