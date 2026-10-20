import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessCreationService } from '../../access-control/creation';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootMutationHandler } from '../../access-control/root-mutation-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionName: 'projects', collectionKey: 'projects-key' };
const customerIdentity = { ...mainIdentity, collectionName: 'customers', collectionKey: 'customers-key' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('finalized reference creation (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let customers: Collection | undefined;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessRootMutationHandler;
  const identity = (collection: Collection) =>
    collection === docs ? mainIdentity : collection === customers ? customerIdentity : projectIdentity;
  const auth = () => ({ tenantId: 'B', roleName: 'editor', userId: 28 });
  const pg = (name: string, run: () => Promise<void>) => it.skipIf(dialect !== 'postgres')(name, run);

  beforeEach(async () => {
    customers = undefined;
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
    await adapter.prepare(ctx, [mainIdentity, projectIdentity, ...(customers ? [customerIdentity] : [])]);
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

  pg('creates exactly 20 independently authorized references', async () => {
    const values: Record<string, number> = { project: 101 };
    const expected: Record<string, number> = { projectId: 101 };
    for (let index = 0; index < 19; index++) {
      const name = `project${index}`;
      const foreignKey = `projectId${index}`;
      docs.setField(name, { type: 'belongsTo', target: 'projects', foreignKey });
      values[name] = index % 2 === 0 ? 101 : 103;
      expected[foreignKey] = values[name];
    }
    await docs.model.sync({ alter: true });
    const ctx = await context('documents', 'create', { values }, { fields: Object.keys(values) });
    const authorize = vi.fn(async (collection: Collection) => {
      expect(collection).toBe(projects);
      return target({ fields: ['id'] });
    });
    await handler.handle(ctx, auth(), authorize);
    expect(authorize).toHaveBeenCalledTimes(20);
    expect((await rows()).map((record) => record.get())).toMatchObject([{ tenantId: 'B', ...expected }]);
    expect(ctx.body).toEqual({ keys: [expect.any(Number)], affected: 1 });
  });

  it('rejects more than 20 references before SQL or target authorization', async () => {
    const values: Record<string, number> = { project: 101 };
    for (let index = 0; index < 20; index++) {
      const name = `project${index}`;
      docs.setField(name, { type: 'belongsTo', target: 'projects', foreignKey: `projectId${index}` });
      values[name] = 103;
    }
    const ctx = await context('documents', 'create', { values });
    const sql = vi.spyOn(db.sequelize, 'query');
    const authorize = vi.fn(async () => null);
    await expect(handler.handle(ctx, auth(), authorize)).rejects.toThrow(/at most 20/i);
    expect(sql).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
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
      await db.getRepository('collections').create({ values: { key: 'customers-key', name: 'customers' } });
      await store.save(customerIdentity, { ...(await store.read(projectIdentity))!, revision: 0 }, { userId: 28 });
    });

    const multipleContext = (values: object = { name: 'Created', project: 101, customer: 201 }, grant: object = {}) =>
      context('documents', 'create', { values }, grant);
    const authorize = (collection: Collection) => context(collection.name, 'list', {}, { fields: ['id'] });

    it('creates both references with independent readable targets and filtered scalar fields', async () => {
      const ctx = await multipleContext(undefined, { fields: ['project', 'customer'] });
      const decision = vi.fn(authorize);
      await handler.handle(ctx, auth(), decision);
      expect(decision.mock.calls.map(([collection]) => collection.name)).toEqual(['projects', 'customers']);
      expect((await rows()).map((record) => record.get())).toMatchObject([
        { tenantId: 'B', name: 'Draft', projectId: 101, customerId: 201 },
      ]);
      expect(ctx.body).toEqual({ keys: [expect.any(Number)], affected: 1 });
      expect((await projects.model.findByPk(101))!.get('tenantId')).toBe('H');
      expect((await customers!.model.findByPk(201))!.get('tenantId')).toBe('H');
    });

    it('rejects the complete create when the second target is hidden', async () => {
      const ctx = await multipleContext({ project: 101, customer: 202 });
      await expect(handler.handle(ctx, auth(), authorize)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await rows()).toEqual([]);
      expect(ctx.body).toBe('unchanged');
    });

    it('does not borrow the first target list permission or role condition for the second', async () => {
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
      expect(await rows()).toEqual([]);
    });

    it.each(['denied', 'hidden key', 'wrong role'])('requires a valid second target grant: %s', async (kind) => {
      const ctx = await multipleContext();
      await expect(
        handler.handle(ctx, auth(), async (collection) => {
          if (collection === projects) return authorize(collection);
          if (kind === 'denied') return null;
          const related = await context(
            collection.name,
            'list',
            {},
            { fields: kind === 'hidden key' ? ['name'] : ['id'] },
          );
          if (kind === 'wrong role') (related.permission as { can: { role: string } }).can.role = 'other';
          return related;
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await rows()).toEqual([]);
      expect(ctx.body).toBe('unchanged');
    });

    it('requires every reference field in the source create grant before requesting target decisions', async () => {
      const ctx = await multipleContext(undefined, { fields: ['project'] });
      const decision = vi.fn(authorize);
      await expect(handler.handle(ctx, auth(), decision)).rejects.toThrow(/field is not authorized/i);
      expect(decision).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
    });

    it('skips only null target decisions while retaining the other readable reference', async () => {
      const ctx = await multipleContext({ project: null, customer: 201 });
      const decision = vi.fn(authorize);
      await handler.handle(ctx, auth(), decision);
      expect(decision.mock.calls.map(([collection]) => collection.name)).toEqual(['customers']);
      expect((await rows()).map((record) => record.get())).toMatchObject([
        { tenantId: 'B', projectId: null, customerId: 201 },
      ]);
    });

    it('creates all-null references without any target list decisions', async () => {
      const ctx = await multipleContext({ project: null, customer: null });
      const decision = vi.fn(async () => null);
      await handler.handle(ctx, auth(), decision);
      expect(decision).not.toHaveBeenCalled();
      expect((await rows()).map((record) => record.get())).toMatchObject([
        { tenantId: 'B', projectId: null, customerId: null },
      ]);
    });

    it('does not claim either referenced historical target', async () => {
      const ctx = await multipleContext({ project: 104, customer: 204 });
      await handler.handle(ctx, auth(), authorize);
      expect((await rows()).map((record) => record.get())).toMatchObject([
        { tenantId: 'B', projectId: 104, customerId: 204 },
      ]);
      expect((await projects.model.findByPk(104))!.get('tenantId')).toBeNull();
      expect((await customers!.model.findByPk(204))!.get('tenantId')).toBeNull();
    });

    it('evaluates source create conditions using both actually inserted references', async () => {
      const ctx = await multipleContext(undefined, {
        filter: { project: { name: 'Visible' }, customer: { name: 'Owned' } },
      });
      await expect(handler.handle(ctx, auth(), authorize)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await rows()).toEqual([]);
      expect(ctx.body).toBe('unchanged');
    });

    it('captures every reference before awaiting the first target decision', async () => {
      const ctx = await multipleContext();
      const actor = auth();
      await handler.handle(ctx, actor, async (collection) => {
        actor.tenantId = 'C';
        (ctx.permission as { rawParams: { values: object } }).rawParams.values = { project: 102, customer: 202 };
        return authorize(collection);
      });
      expect((await rows()).map((record) => record.get())).toMatchObject([
        { tenantId: 'B', projectId: 101, customerId: 201 },
      ]);
    });

    it('captures later relationship metadata before awaiting the first target decision', async () => {
      const ctx = await multipleContext();
      const decision = vi.fn(async (collection: Collection) => {
        docs.model.associations.customer = { ...docs.model.associations.customer } as never;
        return authorize(collection);
      });
      await expect(handler.handle(ctx, auth(), decision)).rejects.toThrow(/association|metadata/i);
      expect(decision).toHaveBeenCalledTimes(1);
      expect(await rows()).toEqual([]);
    });

    it('rechecks earlier relationships after awaiting later target decisions', async () => {
      const ctx = await multipleContext();
      await expect(
        handler.handle(ctx, auth(), async (collection) => {
          if (collection === customers)
            docs.model.associations.project = { ...docs.model.associations.project } as never;
          return authorize(collection);
        }),
      ).rejects.toThrow(/association|metadata/i);
      expect(await rows()).toEqual([]);
      expect(ctx.body).toBe('unchanged');
    });

    it('rolls back a hook that changes only the second stored foreign key', async () => {
      const ctx = await multipleContext();
      docs.model.addHook('beforeCreate', 'second-reference', (record) => {
        record.setDataValue('customerId', 203);
      });
      await expect(handler.handle(ctx, auth(), authorize)).rejects.toThrow(/association values/i);
      expect(await rows()).toEqual([]);
      expect(ctx.body).toBe('unchanged');
    });

    it('checks each registered scope when two references use the same target collection', async () => {
      docs.setField('otherProject', { type: 'belongsTo', target: 'projects', foreignKey: 'otherProjectId' });
      await docs.model.sync({ alter: true });
      (docs.model.associations.project as typeof docs.model.associations.project & { scope: object }).scope = {
        name: 'Visible',
      };
      (docs.model.associations.otherProject as typeof docs.model.associations.otherProject & { scope: object }).scope =
        { name: 'Owned' };
      const ctx = await multipleContext({ project: 101, otherProject: 103 });
      const decision = vi.fn(authorize);
      await handler.handle(ctx, auth(), decision);
      expect(decision).toHaveBeenCalledTimes(2);
      expect((await rows()).map((record) => record.get())).toMatchObject([{ projectId: 101, otherProjectId: 103 }]);
    });

    it('validates later nested values before asking for any target permission', async () => {
      const ctx = await multipleContext({ project: 101, customer: { id: 201 } });
      const decision = vi.fn(authorize);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(handler.handle(ctx, auth(), decision)).rejects.toThrow(/target key or null/i);
      expect(decision).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
    });

    it('keeps the original single-reference service option compatible', async () => {
      const ctx = await multipleContext();
      const service = new AccessCreationService(
        db,
        adapter,
        new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      );
      const result = await service.withCreatedRecords(
        ctx,
        mainIdentity,
        auth(),
        {
          values: [{ name: 'Direct service' }],
          reference: { association: 'project', target: projectIdentity, key: 101 },
        },
        async (plan) => [await docs.repository.create({ values: plan.values[0], transaction: plan.transaction })],
      );
      expect(result).toEqual({ keys: [expect.any(Number)], affected: 1 });
      expect((await rows()).map((record) => record.get())).toMatchObject([{ projectId: 101, customerId: null }]);
    });

    it('rejects ambiguous or duplicate trusted reference plans before writing', async () => {
      const ctx = await multipleContext();
      const service = new AccessCreationService(
        db,
        adapter,
        new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      );
      const reference = { association: 'project', target: projectIdentity, key: 101 };
      const writer = vi.fn(async () => []);
      await expect(
        service.withCreatedRecords(
          ctx,
          mainIdentity,
          auth(),
          {
            values: [{}],
            reference,
            references: [reference],
          },
          writer,
        ),
      ).rejects.toThrow(/either/i);
      await expect(
        service.withCreatedRecords(
          ctx,
          mainIdentity,
          auth(),
          {
            values: [{}],
            references: [reference, reference],
          },
          writer,
        ),
      ).rejects.toThrow(/distinct/i);
      expect(writer).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
    });

    it('rejects a null trusted reference list instead of treating it as scalar-only creation', async () => {
      const ctx = await multipleContext();
      const service = new AccessCreationService(
        db,
        adapter,
        new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      );
      const writer = vi.fn(async () => []);
      await expect(
        service.withCreatedRecords(ctx, mainIdentity, auth(), { values: [{}], references: null as never }, writer),
      ).rejects.toThrow(/bounded dense list/i);
      expect(writer).not.toHaveBeenCalled();
    });
  });
});
