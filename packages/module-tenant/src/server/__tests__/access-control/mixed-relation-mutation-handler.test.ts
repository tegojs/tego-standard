import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessManyToManyService } from '../../access-control/many-to-many';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessMutationService } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import { AccessReferenceMutationHandler } from '../../access-control/reference-mutation-handler';
import { AccessReferenceService } from '../../access-control/references';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('mixed finalized reference updates (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessReferenceMutationHandler;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    ...(collection.name === 'documents'
      ? {}
      : { collectionKey: `${collection.name}-key`, collectionName: collection.name }),
  });
  const actor = () => ({ tenantId: 'B', roleName: 'editor', userId: 28 });
  const pg = (name: string, run: () => Promise<void>) => it.skipIf(dialect !== 'postgres')(name, run);
  const fields = () => [
    { name: 'id', type: 'integer', primaryKey: true },
    { name: 'tenantId', type: 'string' },
    { name: 'name', type: 'string' },
  ];
  const values = () => ({ name: 'Edited', project: 101, customer: 101, projects: [101], customers: [101] });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({ name: 'documents', timestamps: false, fields: fields() });
    for (const [name, single] of [
      ['projects', 'project'],
      ['customers', 'customer'],
    ]) {
      db.collection({ name, timestamps: false, fields: fields() });
      db.collection({ name: `document_${name}`, timestamps: false });
      docs.setField(single, { type: 'belongsTo', target: name, foreignKey: `${single}Id` });
      docs.setField(name, {
        type: 'belongsToMany',
        target: name,
        through: `document_${name}`,
        foreignKey: 'documentId',
        otherKey: 'targetId',
      });
      for (const table of [name, `document_${name}`])
        await db
          .getRepository('collections')
          .create({ values: { key: identity(db.getCollection(table)).collectionKey, name: table } });
    }
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
    for (const name of ['projects', 'customers', 'documents']) {
      const collection = db.getCollection(name);
      if (name !== 'documents')
        await collection.model.bulkCreate([
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
      await store.save(identity(collection), { ...config, revision: 0 }, { userId: 28 });
    }
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'H', name: 'Visible', projectId: 103, customerId: 103 },
      { id: 3, tenantId: 'B', name: 'Owned', projectId: 103, customerId: 103 },
      { id: 5, tenantId: null, name: 'Legacy' },
    ]);
    for (const name of ['projects', 'customers'])
      await db.getRepository(`document_${name}`).create({ values: { documentId: 3, targetId: 103 } });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    handler = new AccessReferenceMutationHandler(
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
  async function context(params: object = {}, grant: object = {}, resourceName = 'documents', actionName = 'update') {
    const acl = new ACL();
    for (const name of ['update', 'list']) acl.setAvailableAction(name, {});
    acl.define({ role: 'editor' }).grantAction(`${resourceName}:${actionName}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: resourceName, actions: { update: {}, list: {} } });
    const action = resourcer.getAction(resourceName, actionName).clone();
    Object.assign(action, { resourceName, actionName, sourceId: undefined, resourceOf: undefined });
    action.mergeParams({
      resourceName,
      actionName,
      ...(actionName === 'update' ? { filterByTk: 3, values: values() } : {}),
      ...params,
    });
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
      [...db.collections.values()]
        .filter((collection) =>
          ['documents', 'projects', 'customers', 'document_projects', 'document_customers'].includes(collection.name),
        )
        .map(identity),
    );
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  const target = (name: string, grant = {}) => context({}, grant, name, 'list');
  const execute = (ctx: Awaited<ReturnType<typeof context>>) =>
    handler.handle(ctx, actor(), (collection) => target(collection.name));
  const linked = async (name: string, id = 3) =>
    (
      await db.getCollection(`document_${name}`).model.findAll({
        where: { documentId: id },
        order: [['targetId', 'ASC']],
      })
    ).map((record) => Number(record.getDataValue('targetId')));
  const unchanged = async (ctx: Awaited<ReturnType<typeof context>>, id = 3) => {
    expect((await docs.model.findByPk(id))!.get()).toMatchObject(
      id === 3
        ? { name: 'Owned', tenantId: 'B', projectId: 103, customerId: 103 }
        : { name: 'Legacy', tenantId: null, projectId: null, customerId: null },
    );
    for (const name of ['projects', 'customers']) expect(await linked(name, id)).toEqual(id === 3 ? [103] : []);
    expect(ctx.body).toBe('unchanged');
  };
  const allowLegacy = async () => {
    const config = configFor({
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity))!.revision }, { userId: 28 });
  };

  for (const reverse of [false, true])
    pg(`saves scalar and both reference types with one source lock and update: reverse=${reverse}`, async () => {
      const input = Object.fromEntries(reverse ? Object.entries(values()).reverse() : Object.entries(values()));
      const ctx = await context({ values: input });
      const authorize = vi.spyOn(AccessMutationService.prototype, 'authorizeExisting');
      const write = vi.spyOn(docs.repository, 'update');
      await execute(ctx);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect((await docs.model.findByPk(3))!.get()).toMatchObject({
        name: 'Edited',
        tenantId: 'B',
        projectId: 101,
        customerId: 101,
      });
      for (const name of ['projects', 'customers']) {
        expect(await linked(name)).toEqual([101]);
        expect((await db.getCollection(name).model.findByPk(101))!.get('tenantId')).toBe('H');
      }
      expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    });

  for (const name of ['project', 'customer', 'projects', 'customers'])
    pg(`rolls back every field when ${name} selects a hidden target`, async () => {
      const ctx = await context({ values: { ...values(), [name]: name.endsWith('s') ? [102] : 102 } });
      await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      await unchanged(ctx);
    });
  for (const grant of [
    { fields: ['name', 'project', 'projects', 'customers'] },
    { fields: ['name', 'project', 'customer', 'projects', 'customers'], blacklist: ['projectId'] },
    { fields: ['name', 'project', 'customer', 'projects', 'customers'], blacklist: ['projects'] },
  ])
    pg(`requires every source field and respects foreign-key blacklists: ${JSON.stringify(grant)}`, async () => {
      const ctx = await context({}, grant);
      const authorize = vi.fn(async () => null);
      await expect(handler.handle(ctx, actor(), authorize)).rejects.toThrow();
      expect(authorize).not.toHaveBeenCalled();
      await unchanged(ctx);
    });
  pg('does not allow source visibility to grant writes', async () => {
    const ctx = await context({ filterByTk: 1 });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect((await docs.model.findByPk(1))!.get('projectId')).toBe(103);
    expect(ctx.body).toBe('unchanged');
  });
  pg('preserves hidden unchanged references and permits unlinking without target reads', async () => {
    await docs.model.update({ projectId: 102, customerId: 102 }, { where: { id: 3 } });
    for (const name of ['projects', 'customers'])
      await db.getCollection(`document_${name}`).model.update({ targetId: 102 }, { where: { documentId: 3 } });
    const ctx = await context({
      values: { name: 'Edited', project: 102, customer: null, projects: [102], customers: [] },
    });
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, actor(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect((await docs.model.findByPk(3))!.get()).toMatchObject({ projectId: 102, customerId: null });
    expect(await linked('projects')).toEqual([102]);
    expect(await linked('customers')).toEqual([]);
  });
  pg('claims an edited historical source but not its referenced historical targets', async () => {
    await allowLegacy();
    const ctx = await context({ filterByTk: 5, values: { project: 104, projects: [104] } });
    await execute(ctx);
    expect((await docs.model.findByPk(5))!.get()).toMatchObject({ tenantId: 'B', projectId: 104 });
    expect(await linked('projects', 5)).toEqual([104]);
    expect((await db.getCollection('projects').model.findByPk(104))!.get('tenantId')).toBeNull();
  });
  pg('does not write or claim an unchanged historical source', async () => {
    await allowLegacy();
    const ctx = await context({
      filterByTk: 5,
      values: { name: 'Legacy', project: null, projects: [], tenantId: null },
    });
    const write = vi.spyOn(docs.repository, 'update');
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, actor(), authorize);
    expect(write).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect((await docs.model.findByPk(5))!.get('tenantId')).toBeNull();
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
  });
  pg('rolls back references, links, legacy claims and notifications when a join hook fails', async () => {
    await allowLegacy();
    const ctx = await context({ filterByTk: 5 });
    const notified = vi.fn();
    docs.model.addHook('afterUpdate', (_record, options) => options.transaction!.afterCommit(notified));
    const error = new Error('join failed');
    db.getCollection('document_projects').model.addHook('afterBulkCreate', () => {
      throw error;
    });
    await expect(execute(ctx)).rejects.toBe(error);
    expect(notified).not.toHaveBeenCalled();
    await unchanged(ctx, 5);
  });
  pg('rejects join hooks changing a selected single-value reference', async () => {
    const ctx = await context();
    db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_rows, options) => {
      await docs.model.update({ projectId: 102 }, { where: { id: 3 }, transaction: options.transaction });
    });
    await expect(execute(ctx)).rejects.toThrow();
    await unchanged(ctx);
  });
  pg('captures single and array values and actor before target authorization', async () => {
    const ctx = await context();
    const auth = actor();
    await handler.handle(ctx, auth, async (collection) => {
      const raw = (ctx.permission as { rawParams: { values: ReturnType<typeof values> } }).rawParams.values;
      raw.project = 102;
      raw.customer = 102;
      raw.projects[0] = 102;
      raw.customers[0] = 102;
      auth.tenantId = 'C';
      return target(collection.name);
    });
    expect((await docs.model.findByPk(3))!.get()).toMatchObject({ tenantId: 'B', projectId: 101, customerId: 101 });
    expect(await linked('projects')).toEqual([101]);
    expect(await linked('customers')).toEqual([101]);
  });
  for (const field of ['project', 'projects'])
    pg(`rechecks mixed relationship metadata during authorization: ${field}`, async () => {
      const ctx = await context();
      await expect(
        handler.handle(ctx, actor(), async (collection) => {
          const related = await target(collection.name);
          Object.assign(docs.model.associations[field], { scope: { name: 'Hidden' } });
          return related;
        }),
      ).rejects.toThrow();
      await unchanged(ctx);
    });

  for (const denied of [1, 2, 3, 4])
    pg(`requires an independent finalized target decision for selection ${denied}`, async () => {
      const ctx = await context();
      let calls = 0;
      await expect(
        handler.handle(ctx, actor(), async (collection) => {
          const related = await target(collection.name);
          if (++calls === denied) (related.permission as { can: unknown }).can = false;
          return related;
        }),
      ).rejects.toThrow();
      expect(calls).toBe(denied);
      await unchanged(ctx);
    });
  pg('retains each target role scope rather than reusing a grant for the same table', async () => {
    const ctx = await context();
    let calls = 0;
    await expect(
      handler.handle(ctx, actor(), async (collection) =>
        target(collection.name, ++calls === 3 ? { filter: { name: 'Owned' } } : {}),
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(calls).toBe(3);
    await unchanged(ctx);
  });
  pg('requires primary-key read permission for each changed target', async () => {
    const ctx = await context();
    let calls = 0;
    await expect(
      handler.handle(ctx, actor(), async (collection) =>
        target(collection.name, ++calls === 2 ? { fields: ['name'] } : {}),
      ),
    ).rejects.toThrow('key is not readable');
    await unchanged(ctx);
  });
  for (const field of ['project', 'projects'])
    pg(`applies relationship-specific scope to ${field} independently`, async () => {
      Object.assign(docs.model.associations[field], { scope: { name: 'Owned' } });
      const denied = await context();
      await expect(execute(denied)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      await unchanged(denied);
      const allowed = await context({ values: { ...values(), [field]: field === 'project' ? 103 : [103] } });
      await execute(allowed);
      expect((await docs.model.findByPk(3))!.get('projectId')).toBe(field === 'project' ? 103 : 101);
      expect(await linked('projects')).toEqual(field === 'projects' ? [103] : [101]);
    });
  pg('filters scalar fields and permits an authorized save to leave its prior role range', async () => {
    const filtered = await context(
      {},
      { fields: ['project', 'customer', 'projects', 'customers'], filter: { name: 'Owned' } },
    );
    await execute(filtered);
    expect((await docs.model.findByPk(3))!.get('name')).toBe('Owned');
    const changed = await context(
      { values: { name: 'Submitted', project: 103, projects: [103] } },
      { fields: ['project', 'projects', 'name'], filter: { name: 'Owned' } },
    );
    await execute(changed);
    expect((await docs.model.findByPk(3))!.get('name')).toBe('Submitted');
    expect(changed.body).toEqual({ keys: [3], affected: 1 });
  });
  pg('rejects ownership transfer even when tenantId is outside the field whitelist', async () => {
    const ctx = await context(
      { values: { project: 101, projects: [101], tenantId: 'C' } },
      { fields: ['project', 'projects'] },
    );
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    await unchanged(ctx);
  });
  pg('verifies other protected foreign keys after join hooks', async () => {
    const ctx = await context({ values: { project: 101, projects: [101] } });
    db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_rows, options) => {
      await docs.model.update({ customerId: 102 }, { where: { id: 3 }, transaction: options.transaction });
    });
    await expect(execute(ctx)).rejects.toThrow('another protected relationship');
    await unchanged(ctx);
  });
  pg('rejects a writer that does not persist the authorized single-value references', async () => {
    const ctx = await context();
    vi.spyOn(docs.repository, 'update').mockResolvedValue([]);
    await expect(execute(ctx)).rejects.toThrow('authorized foreign key');
    await unchanged(ctx);
  });
  pg('rechecks the preparation phase after the final source query', async () => {
    const ctx = await context();
    const original = docs.model.findAll.bind(docs.model);
    let armed = false;
    db.getCollection('document_projects').model.addHook('afterBulkCreate', () => {
      armed = true;
    });
    vi.spyOn(docs.model, 'findAll').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (armed && (args[0] as { hooks?: boolean }).hooks === false) adapter.release(ctx);
      return result;
    });
    await expect(execute(ctx)).rejects.toThrow();
    await unchanged(ctx);
  });
  pg('rolls back a prospective historical claim when another selection is hidden', async () => {
    await allowLegacy();
    const ctx = await context({ filterByTk: 5, values: { project: 104, projects: [102] } });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await unchanged(ctx, 5);
  });
  for (const patch of [{ project: { id: 101 } }, { projects: [{ id: 101 }] }, { projectId: 101 }])
    it(`rejects nested and raw foreign-key input before SQL: ${JSON.stringify(patch)}`, async () => {
      const ctx = await context({ values: { ...values(), ...patch } });
      const sql = vi.spyOn(db.sequelize, 'query');
      const authorize = vi.fn(async () => null);
      await expect(handler.handle(ctx, actor(), authorize)).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
    });
  pg('shares the twenty-field limit across both relationship types', async () => {
    const input: Record<string, unknown> = { project: 101, projects: [] };
    for (let index = 0; index < 18; index++) {
      const name = `reference${index}`;
      docs.setField(name, { type: 'belongsTo', target: 'projects', foreignKey: `reference${index}Id` });
      input[name] = null;
    }
    await db.sync();
    const allowed = await context({ values: input });
    await execute(allowed);
    expect(allowed.body).toEqual({ keys: [3], affected: 1 });
    const denied = await context({ values: { ...input, customer: 101 } });
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(execute(denied)).rejects.toThrow(/between 1 and 20/);
    expect(sql).not.toHaveBeenCalled();
  });

  const service = () => {
    const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
    return new AccessManyToManyService(
      db,
      adapter,
      queries,
      new AccessMutationService(db, adapter, queries),
      new AccessReferenceService(db, adapter, queries),
    );
  };
  const linkRequest = () => ({
    sourceKeys: [3],
    links: [
      {
        association: 'projects',
        operation: 'set' as const,
        target: identity(db.getCollection('projects')),
        through: identity(db.getCollection('document_projects')),
        targetKeys: [101],
      },
    ],
    references: [{ association: 'project', target: identity(db.getCollection('projects')), targetKey: 101 }],
  });
  for (const kind of ['null', 'sparse', 'symbol', 'prototype', 'accessor', 'duplicate', 'limit', 'unknown property'])
    pg(`rejects malformed trusted mixed reference lists before SQL: ${kind}`, async () => {
      const ctx = await context();
      const request = linkRequest();
      if (kind === 'null') request.references = null!;
      if (kind === 'sparse') delete request.references[0];
      if (kind === 'symbol') Object.defineProperty(request.references, Symbol('extra'), { value: true });
      if (kind === 'prototype') Object.setPrototypeOf(request.references, Object.create(Array.prototype));
      if (kind === 'accessor')
        Object.defineProperty(request.references, '0', {
          get() {
            throw new Error('must not invoke');
          },
        });
      if (kind === 'duplicate') request.references.push(request.references[0]);
      if (kind === 'limit') request.references.push(...Array.from({ length: 19 }, () => request.references[0]));
      if (kind === 'unknown property') Object.assign(request.references[0], { values: { name: 'Forged' } });
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(service().withLinkSets(ctx, mainIdentity, actor(), request)).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
      expect(sql).not.toHaveBeenCalled();
    });
  pg('requires an independent reference scope from trusted entry callers', async () => {
    const ctx = await context();
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(
      service().withLinkSets(ctx, mainIdentity, actor(), linkRequest(), {
        assertCurrent() {},
        targetScope: async () => ({}),
      }),
    ).rejects.toThrow('independent reference permissions');
    expect(sql).not.toHaveBeenCalled();
  });
  pg('does not silently drop a submitted field when a metadata callback changes its relationship type', async () => {
    const ctx = await context();
    let changed = false;
    const changingHandler = new AccessReferenceMutationHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      (collection) => {
        if (collection === docs && !changed) {
          changed = true;
          Object.assign(docs.model.associations.customer, { associationType: 'HasMany' });
        }
        return identity(collection);
      },
    );
    const authorize = vi.fn((collection: Collection) => target(collection.name));
    const sql = vi.spyOn(db.sequelize, 'query');
    await expect(changingHandler.handle(ctx, actor(), authorize)).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(sql).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    await unchanged(ctx);
  });
  pg('retains explicit low-level target conditions for unchanged single-value references', async () => {
    const ctx = await context();
    const request = linkRequest();
    Object.assign(request.references[0], { targetKey: 103, targetWhere: { name: 'Hidden' } });
    await expect(service().withLinkSets(ctx, mainIdentity, actor(), request)).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    await unchanged(ctx);
  });
});
