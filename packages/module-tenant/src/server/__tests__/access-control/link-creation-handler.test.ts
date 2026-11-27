import { ACL, Resourcer, Transaction, type Collection, type Database } from '@tego/server';

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

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('finalized link creation (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessRootMutationHandler;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    ...(collection.name === 'documents'
      ? {}
      : { collectionKey: `${collection.name}-key`, collectionName: collection.name }),
  });
  const actor = () => ({ tenantId: 'B', roleName: 'editor', userId: 28 });
  const pg = (name: string, run: () => Promise<void>) => it.skipIf(dialect !== 'postgres')(name, run);

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({
      name: 'documents',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'projectId', type: 'integer' },
      ],
    });
    for (const name of ['projects', 'customers']) {
      const target = db.collection({
        name,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'tenantId', type: 'string' },
          { name: 'name', type: 'string' },
        ],
      });
      const through = db.collection({ name: `document_${name}`, timestamps: false });
      docs.setField(name, {
        type: 'belongsToMany',
        target: name,
        through: through.name,
        foreignKey: 'documentId',
        otherKey: 'targetId',
      });
      for (const collection of [target, through])
        await db
          .getRepository('collections')
          .create({ values: { key: identity(collection).collectionKey, name: collection.name } });
    }
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
    await db.sync();
    await tenants.model.create({ id: 'B', enabled: true });
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    for (const name of ['projects', 'customers']) {
      const target = db.getCollection(name);
      await target.model.bulkCreate([
        { id: 101, tenantId: 'H', name: 'Visible' },
        { id: 102, tenantId: 'C', name: 'Hidden' },
        { id: 103, tenantId: 'B', name: 'Owned' },
        { id: 104, tenantId: null, name: 'Legacy' },
      ]);
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
      await store.save(identity(target), { ...config, revision: 0 }, { userId: 28 });
    }
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

  async function context(
    values: object = { name: 'Created', project: 101, projects: [101, 104], customers: [103] },
    grant: object = {},
    resourceName = 'documents',
  ) {
    const actionName = resourceName === 'documents' ? 'create' : 'list';
    const acl = new ACL();
    for (const name of ['create', 'list']) acl.setAvailableAction(name, {});
    acl.define({ role: 'editor' }).grantAction(`${resourceName}:${actionName}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: resourceName, actions: { create: {}, list: {} } });
    const action = resourcer.getAction(resourceName, actionName).clone();
    Object.assign(action, { resourceName, actionName, sourceId: undefined, resourceOf: undefined });
    action.mergeParams({ resourceName, actionName, ...(actionName === 'create' ? { values } : {}) });
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
    await adapter.prepare(
      ctx,
      ['documents', 'projects', 'customers', 'document_projects', 'document_customers'].map((name) =>
        identity(db.getCollection(name)),
      ),
    );
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  const target = (name: string, grant: object = {}) => context({}, grant, name);
  const execute = (ctx: Awaited<ReturnType<typeof context>>) =>
    handler.handle(ctx, actor(), (collection) => target(collection.name));
  const rows = () => docs.model.findAll();
  const links = async (name: string) =>
    (await db.getCollection(`document_${name}`).model.findAll({ order: [['targetId', 'ASC']] })).map((row) =>
      Number(row.getDataValue('targetId')),
    );

  pg('creates scalar fields, a single reference and two link sets atomically without claiming targets', async () => {
    const ctx = await context(undefined, { fields: ['name', 'project', 'projects', 'customers'] });
    await execute(ctx);
    expect(ctx.body).toEqual({ keys: [expect.any(Number)], affected: 1 });
    expect((await rows()).map((row) => row.get())).toMatchObject([{ name: 'Created', projectId: 101, tenantId: 'B' }]);
    expect(await links('projects')).toEqual([101, 104]);
    expect(await links('customers')).toEqual([103]);
    expect((await db.getCollection('projects').model.findByPk(101))!.get('tenantId')).toBe('H');
    expect((await db.getCollection('projects').model.findByPk(104))!.get('tenantId')).toBeNull();
  });

  async function unchanged(ctx: Awaited<ReturnType<typeof context>>) {
    expect(await rows()).toEqual([]);
    expect(await links('projects')).toEqual([]);
    expect(await links('customers')).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  }

  for (const stage of ['source insert', 'connection insert'])
    pg(`rechecks linked targets made unreadable by a ${stage} hook`, async () => {
      const ctx = await context({ name: 'Created', projects: [101] });
      const projects = db.getCollection('projects');
      let notified = false;
      const hide = async (_row, options) => {
        options.transaction.afterCommit(() => {
          notified = true;
        });
        await projects.model.update(
          { name: 'No longer visible' },
          { where: { id: 101 }, transaction: options.transaction },
        );
      };
      if (stage === 'source insert') docs.model.addHook('afterCreate', 'hide-link-target', hide);
      else db.getCollection('document_projects').model.addHook('afterBulkCreate', 'hide-link-target', hide);
      await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      await unchanged(ctx);
      expect((await projects.model.findByPk(101))!.get('name')).toBe('Visible');
      expect(notified).toBe(false);
    });

  pg('rechecks linked targets after the caller persistence stage without committing its transaction', async () => {
    const ctx = await context({});
    const projects = db.getCollection('projects');
    const through = db.getCollection('document_projects');
    const creation = new AccessCreationService(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
    );
    let notified = false;
    await expect(
      db.sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, async (transaction) => {
        transaction.afterCommit(() => {
          notified = true;
        });
        return creation.withCreatedRecordsInTransaction(
          ctx,
          mainIdentity,
          actor(),
          {
            values: [{ name: 'Created' }],
            links: [{ association: 'projects', target: identity(projects), through: identity(through), keys: [101] }],
          },
          transaction,
          async (plan) => [await docs.repository.create({ values: plan.values[0], transaction: plan.transaction })],
          undefined,
          async () => {
            await projects.model.update({ name: 'No longer visible' }, { where: { id: 101 }, transaction });
          },
        );
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await unchanged(ctx);
    expect((await projects.model.findByPk(101))!.get('name')).toBe('Visible');
    expect(notified).toBe(false);
  });

  pg('rechecks the target role condition after a link hook changes a still-visible target', async () => {
    const ctx = await context({ name: 'Created', projects: [103] });
    db.getCollection('document_projects').model.addHook(
      'afterBulkCreate',
      'change-link-target',
      async (_rows, options) => {
        await db
          .getCollection('projects')
          .model.update({ name: 'Changed' }, { where: { id: 103 }, transaction: options.transaction });
      },
    );
    await expect(
      handler.handle(ctx, actor(), (collection) => target(collection.name, { filter: { name: 'Owned' } })),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await unchanged(ctx);
    expect((await db.getCollection('projects').model.findByPk(103))!.get('name')).toBe('Owned');
  });

  pg('allows a link hook to change target fields when its finalized read scope still permits it', async () => {
    const ctx = await context({ name: 'Created', projects: [103] });
    db.getCollection('document_projects').model.addHook(
      'afterBulkCreate',
      'change-readable-link-target',
      async (_rows, options) => {
        await db
          .getCollection('projects')
          .model.update({ name: 'Changed but owned' }, { where: { id: 103 }, transaction: options.transaction });
      },
    );
    await execute(ctx);
    expect(await links('projects')).toEqual([103]);
    expect((await db.getCollection('projects').model.findByPk(103))!.get()).toMatchObject({
      name: 'Changed but owned',
      tenantId: 'B',
    });
  });

  for (const name of ['projects', 'customers']) {
    pg(`checks every ${name} selection before inserting the source`, async () => {
      const ctx = await context({ project: 101, projects: [101], customers: [103], [name]: [101, 102] });
      const write = vi.spyOn(docs.repository, 'create');
      await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(write).not.toHaveBeenCalled();
      await unchanged(ctx);
    });
    pg(`applies the independent final ${name} role condition`, async () => {
      const ctx = await context();
      await expect(
        handler.handle(ctx, actor(), (collection) =>
          target(collection.name, collection.name === name ? { fields: ['id'], filter: { name: 'Denied' } } : {}),
        ),
      ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      await unchanged(ctx);
    });
    pg(`requires a readable primary key for ${name}`, async () => {
      const ctx = await context();
      await expect(
        handler.handle(ctx, actor(), (collection) =>
          target(collection.name, collection.name === name ? { fields: ['name'] } : {}),
        ),
      ).rejects.toThrow(/key is not readable/i);
      await unchanged(ctx);
    });
    pg(`checks the registered ${name} relationship scope`, async () => {
      Object.assign(docs.model.associations[name], { scope: { name: 'Denied' } });
      const ctx = await context();
      await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      await unchanged(ctx);
    });
    it(`requires source field permission for ${name} before target authorization`, async () => {
      const ctx = await context(undefined, {
        fields: ['name', 'project', name === 'projects' ? 'customers' : 'projects'],
      });
      const authorize = vi.fn(async () => null);
      await expect(handler.handle(ctx, actor(), authorize)).rejects.toThrow(/field is not authorized/i);
      expect(authorize).not.toHaveBeenCalled();
      await unchanged(ctx);
    });
    it(`captures later ${name} metadata before the first asynchronous decision`, async () => {
      const ctx = await context();
      const authorize = vi.fn(async (collection: Collection) => {
        Object.assign(docs.model.associations[name], { scope: { name: 'Changed' } });
        return target(collection.name);
      });
      await expect(handler.handle(ctx, actor(), authorize)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(authorize).toHaveBeenCalledTimes(1);
      await unchanged(ctx);
    });
  }

  pg('allows empty link selections and a null single reference without target list permission', async () => {
    const ctx = await context({ name: 'Empty', project: null, projects: [], customers: [] });
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, actor(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect((await rows()).map((row) => row.get())).toMatchObject([{ name: 'Empty', tenantId: 'B', projectId: null }]);
    expect(await links('projects')).toEqual([]);
  });

  pg('deduplicates equivalent target keys without duplicate join rows', async () => {
    const ctx = await context({ projects: [101, '0101', 104] });
    await execute(ctx);
    expect(await links('projects')).toEqual([101, 104]);
  });

  pg('rejects missing targets before source insertion', async () => {
    const ctx = await context({ projects: [999] });
    const write = vi.spyOn(docs.repository, 'create');
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(write).not.toHaveBeenCalled();
    await unchanged(ctx);
  });

  pg('evaluates source role conditions after the selected links have been persisted', async () => {
    const ctx = await context(undefined, { filter: { customers: { name: 'Owned' } } });
    await execute(ctx);
    expect(await links('customers')).toEqual([103]);
    const denied = await context({ customers: [101] }, { filter: { customers: { name: 'Owned' } } });
    await expect(execute(denied)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await docs.model.count()).toBe(1);
    expect(await links('customers')).toEqual([103]);
  });

  pg('evaluates relational ownership against the inserted candidate including its new links', async () => {
    const previous = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      {
        ...configFor({
          type: 'all',
          children: [
            ownerCondition,
            {
              type: 'exists',
              path: 'customers',
              condition: {
                type: 'compare',
                operator: 'eq',
                left: { type: 'field', path: 'name' },
                right: { type: 'literal', value: 'Owned' },
              },
            },
          ],
        }),
        revision: previous.revision,
      },
      { userId: 28 },
    );
    const ctx = await context();
    await execute(ctx);
    expect(await links('customers')).toEqual([103]);
    const denied = await context({ customers: [101] });
    await expect(execute(denied)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await docs.model.count()).toBe(1);
  });

  pg('never borrows target visibility as source ownership authorization', async () => {
    const previous = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: previous.revision },
      { userId: 28 },
    );
    const ctx = await context();
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await unchanged(ctx);
  });

  pg('captures every input array and the authenticated actor before asynchronous decisions', async () => {
    const ctx = await context();
    const auth = actor();
    await handler.handle(ctx, auth, async (collection) => {
      const raw = (
        ctx.permission as {
          rawParams: { values: { name: string; project: number; projects: number[]; customers: number[] } };
        }
      ).rawParams.values;
      raw.name = 'Forged';
      raw.project = 102;
      raw.projects[0] = 102;
      raw.customers[0] = 102;
      auth.tenantId = 'C';
      return target(collection.name);
    });
    expect((await rows()).map((row) => row.get())).toMatchObject([{ name: 'Created', projectId: 101, tenantId: 'B' }]);
    expect(await links('projects')).toEqual([101, 104]);
    expect(await links('customers')).toEqual([103]);
  });

  pg(
    'rolls back source, references, previous links and afterCommit notifications on a later join failure',
    async () => {
      const ctx = await context();
      const notified = vi.fn();
      docs.model.addHook('afterCreate', (_row, options) => {
        options.transaction!.afterCommit(notified);
      });
      db.getCollection('document_projects').model.addHook('afterBulkCreate', (_rows, options) => {
        options.transaction!.afterCommit(notified);
      });
      const error = new Error('second join failed');
      db.getCollection('document_customers').model.addHook('afterBulkCreate', () => {
        throw error;
      });
      await expect(execute(ctx)).rejects.toBe(error);
      expect(notified).not.toHaveBeenCalled();
      await unchanged(ctx);
    },
  );

  for (const field of ['tenantId', 'projectId'])
    pg(`verifies persisted ${field} after all join hooks`, async () => {
      const ctx = await context();
      db.getCollection('document_customers').model.addHook('afterBulkCreate', async (_rows, options) => {
        await docs.model.update(
          { [field]: field === 'tenantId' ? 'C' : 102 },
          { where: {}, transaction: options.transaction },
        );
      });
      await expect(execute(ctx)).rejects.toThrow();
      await unchanged(ctx);
    });

  pg('rejects a later join hook altering an earlier selected link set', async () => {
    const ctx = await context();
    db.getCollection('document_customers').model.addHook('afterBulkCreate', async (_rows, options) => {
      await db
        .getCollection('document_projects')
        .model.update({ targetId: 102 }, { where: { targetId: 101 }, transaction: options.transaction });
    });
    await expect(execute(ctx)).rejects.toThrow(/connections/i);
    await unchanged(ctx);
  });

  pg('rejects source hooks adding unplanned links before the controlled join operation', async () => {
    const ctx = await context();
    docs.model.addHook('afterCreate', async (row, options) => {
      await db
        .getCollection('document_projects')
        .model.create({ documentId: row.get('id'), targetId: 102 }, { transaction: options.transaction });
    });
    await expect(execute(ctx)).rejects.toThrow(/unplanned connections/i);
    await unchanged(ctx);
  });

  it('fails closed when preparation ends during target authorization', async () => {
    const ctx = await context();
    await expect(
      handler.handle(ctx, actor(), async (collection) => {
        adapter.release(ctx);
        return target(collection.name);
      }),
    ).rejects.toThrow(/phase|prepared/i);
    await unchanged(ctx);
  });

  for (const value of [null, 101, [{ id: 101 }], [true], [Number.MAX_SAFE_INTEGER + 1]])
    it(`rejects malformed link selections before authorization: ${JSON.stringify(value)}`, async () => {
      const ctx = await context({ project: 101, projects: [101], customers: value });
      const query = vi.spyOn(db.sequelize, 'query');
      const authorize = vi.fn(async () => null);
      await expect(handler.handle(ctx, actor(), authorize)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(query).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
    });

  for (const kind of ['sparse', 'symbol', 'prototype', 'accessor', 'oversized'])
    it(`rejects malformed original key arrays before normalization: ${kind}`, async () => {
      const ctx = await context();
      const raw = (ctx.permission as { rawParams: { values: { projects: number[] } } }).rawParams.values.projects;
      if (kind === 'sparse') delete raw[0];
      if (kind === 'symbol') Object.defineProperty(raw, Symbol('extra'), { value: true });
      if (kind === 'prototype') Object.setPrototypeOf(raw, Object.create(Array.prototype));
      if (kind === 'oversized') raw.push(...Array.from({ length: 1000 }, (_, i) => i + 2000));
      if (kind === 'accessor')
        Object.defineProperty(raw, '0', {
          get() {
            throw new Error('must not invoke accessor');
          },
        });
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(execute(ctx)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(query).not.toHaveBeenCalled();
    });

  it('rejects business-bearing join tables before target authorization', async () => {
    db.getCollection('document_projects').setField('amount', { type: 'integer' });
    const ctx = await context();
    const authorize = vi.fn(async () => null);
    await expect(handler.handle(ctx, actor(), authorize)).rejects.toThrow(/business fields/i);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('rejects conditionally controlled join tables before target authorization', async () => {
    const through = db.getCollection('document_projects');
    await store.save(
      identity(through),
      {
        ...configFor({
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'targetId' },
          right: { type: 'literal', value: 101 },
        }),
        ownership: { enabled: false },
        revision: 0,
      },
      { userId: 28 },
    );
    const ctx = await context();
    await expect(execute(ctx)).rejects.toThrow(/independently controlled/i);
  });

  it('rejects duplicate trusted association names shared by references and links', async () => {
    const ctx = await context();
    const writer = vi.fn();
    await expect(
      new AccessCreationService(
        db,
        adapter,
        new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      ).withCreatedRecords(
        ctx,
        mainIdentity,
        actor(),
        {
          values: [{ name: 'Created' }],
          references: [{ association: 'project', target: identity(db.getCollection('projects')), key: 101 }],
          links: [
            {
              association: 'project',
              target: identity(db.getCollection('projects')),
              through: identity(db.getCollection('document_projects')),
              keys: [101],
            },
          ],
        },
        writer,
      ),
    ).rejects.toThrow(/distinct registered association/i);
    expect(writer).not.toHaveBeenCalled();
  });

  it('rejects explicit null trusted link lists before writing', async () => {
    const ctx = await context();
    const writer = vi.fn();
    await expect(
      new AccessCreationService(
        db,
        adapter,
        new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      ).withCreatedRecords(
        ctx,
        mainIdentity,
        actor(),
        {
          values: [{ name: 'Created' }],
          links: null as never,
        },
        writer,
      ),
    ).rejects.toThrow(/bounded dense list/i);
    expect(writer).not.toHaveBeenCalled();
  });

  for (const allowed of [true, false])
    it(`preserves ordinary JSON array creation when the field is ${allowed ? 'authorized' : 'filtered out'}`, async () => {
      docs.setField('details', { type: 'json' });
      await docs.model.sync({ alter: true });
      const details = Array.from({ length: 1001 }, (_, index) => index);
      const ctx = await context({ name: 'JSON', details }, { fields: allowed ? ['name', 'details'] : ['name'] });
      await execute(ctx);
      const [row] = await rows();
      expect(row.get('name')).toBe('JSON');
      if (allowed) expect(row.get('details')).toEqual(details);
      else expect(row.get('details')).toBeNull();
    });

  pg('checks separate list decisions for a single reference and links to the same target table', async () => {
    const ctx = await context();
    let projectDecisions = 0;
    await expect(
      handler.handle(ctx, actor(), (collection) =>
        target(
          collection.name,
          collection.name === 'projects' && ++projectDecisions === 2 ? { filter: { name: 'Denied' } } : {},
        ),
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(projectDecisions).toBe(2);
    await unchanged(ctx);
  });

  for (const bulk of [false, true])
    pg(
      `rejects extra ${bulk ? 'bulk' : 'single'} source inserts from join hooks and removes the INSERT observer`,
      async () => {
        const ctx = await context();
        const notified = vi.fn();
        const hooksBefore = [
          ...((db.sequelize as unknown as { options: { hooks: { afterQuery?: unknown[] } } }).options.hooks
            .afterQuery ?? []),
        ];
        db.getCollection('document_customers').model.addHook('afterBulkCreate', async (_rows, options) => {
          options.transaction!.afterCommit(notified);
          const values = { name: 'Unauthorized source', tenantId: 'C' };
          if (bulk) await docs.model.bulkCreate([values], { transaction: options.transaction, hooks: false });
          else await docs.model.create(values, { transaction: options.transaction });
        });
        await expect(execute(ctx)).rejects.toThrow(/INSERT receipts/i);
        expect(notified).not.toHaveBeenCalled();
        await unchanged(ctx);
        expect(
          (db.sequelize as unknown as { options: { hooks: { afterQuery?: unknown[] } } }).options.hooks.afterQuery ??
            [],
        ).toEqual(hooksBefore);
      },
    );

  pg('rejects a final target list decision for a different role', async () => {
    const ctx = await context({ projects: [101] });
    await expect(
      handler.handle(ctx, actor(), async (collection) => {
        const related = await target(collection.name);
        (related.permission as { can: { role: string } }).can.role = 'other';
        return related;
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    await unchanged(ctx);
  });

  pg('checks active preparation again after the final join query', async () => {
    const ctx = await context();
    const through = db.getCollection('document_customers').model;
    const find = through.findAll.bind(through);
    let reads = 0;
    vi.spyOn(through, 'findAll').mockImplementation(async (...args) => {
      const result = await find(...args);
      if ((args[0] as { hooks?: boolean; lock?: unknown }).hooks === false && args[0]?.lock && ++reads === 2)
        adapter.release(ctx);
      return result;
    });
    await expect(execute(ctx)).rejects.toThrow();
    await unchanged(ctx);
  });

  pg('accepts twenty combined relationship fields and rejects twenty-one before SQL', async () => {
    const values: Record<string, unknown> = { name: 'Created', project: null, projects: [], customers: [] };
    for (let index = 3; index < 20; index++) {
      const name = `reference${index}`;
      docs.setField(name, { type: 'belongsTo', target: 'projects', foreignKey: `${name}Id` });
      values[name] = null;
    }
    await docs.model.sync({ alter: true });
    const ctx = await context(values);
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, actor(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect(await docs.model.count()).toBe(1);
    docs.setField('extra', { type: 'belongsTo', target: 'projects', foreignKey: 'extraId' });
    const denied = await context({ ...values, extra: null });
    const query = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(denied, actor(), authorize)).rejects.toThrow(/at most 20/i);
    expect(query).not.toHaveBeenCalled();
  });

  it.skipIf(dialect !== 'sqlite')('rejects relational creation on unsupported dialects without writing', async () => {
    const ctx = await context();
    const write = vi.spyOn(docs.repository, 'create');
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    expect(write).not.toHaveBeenCalled();
    await unchanged(ctx);
  });
});
