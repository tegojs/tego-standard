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

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('multiple finalized link updates (%s)', (dialect) => {
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
  const addRelation = async (name: string) => {
    const target = db.collection({ name, timestamps: false, fields: fields() });
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
    return { target, through };
  };

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({ name: 'documents', timestamps: false, fields: fields() });
    await addRelation('projects');
    await addRelation('customers');
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
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'H', name: 'Visible' },
      { id: 3, tenantId: 'B', name: 'Owned' },
      { id: 5, tenantId: null, name: 'Legacy' },
    ]);
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    for (const name of ['documents', 'projects', 'customers']) {
      const collection = db.getCollection(name);
      if (name !== 'documents') {
        await collection.model.bulkCreate([
          { id: 101, tenantId: 'H', name: 'Visible' },
          { id: 102, tenantId: 'C', name: 'Hidden' },
          { id: 103, tenantId: 'B', name: 'Owned' },
          { id: 104, tenantId: null, name: 'Legacy' },
        ]);
        await db.getRepository(`document_${name}`).create({ values: { documentId: 3, targetId: 103 } });
      }
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
      ...(actionName === 'update'
        ? { filterByTk: 3, values: { name: 'Edited', projects: [101], customers: [101] } }
        : {}),
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
        .filter(
          (collection) =>
            collection.name === 'documents' ||
            Object.hasOwn(docs.model.associations, collection.name) ||
            collection.name.startsWith('document_'),
        )
        .map(identity),
    );
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  const target = (name: string, grant = {}, params = {}) => context(params, grant, name, 'list');
  const execute = async (ctx: Awaited<ReturnType<typeof context>>) =>
    handler.handle(ctx, actor(), (collection) => target(collection.name));
  const linked = async (name: string, id = 3) =>
    (
      await db.getCollection(`document_${name}`).model.findAll({
        where: { documentId: id },
        order: [['targetId', 'ASC']],
      })
    ).map((record) => Number(record.getDataValue('targetId')));

  pg('saves two independent link sets and scalar fields in one source update', async () => {
    const ctx = await context();
    const sourceAuthorization = vi.spyOn(AccessMutationService.prototype, 'authorizeExisting');
    const sourceWrite = vi.spyOn(docs.repository, 'update');
    await execute(ctx);
    expect(sourceAuthorization).toHaveBeenCalledTimes(1);
    expect(sourceWrite).toHaveBeenCalledTimes(1);
    expect(await linked('projects')).toEqual([101]);
    expect(await linked('customers')).toEqual([101]);
    expect((await docs.model.findByPk(3))!.get('name')).toBe('Edited');
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    for (const name of ['projects', 'customers'])
      expect((await db.getCollection(name).model.findByPk(101))!.get('tenantId')).toBe('H');
  });

  const unchanged = async (ctx: Awaited<ReturnType<typeof context>>, id = 3, name = 'Owned') => {
    expect(await linked('projects', id)).toEqual(id === 3 ? [103] : []);
    expect(await linked('customers', id)).toEqual(id === 3 ? [103] : []);
    expect((await docs.model.findByPk(id))!.get('name')).toBe(name);
    expect(ctx.body).toBe('unchanged');
  };
  const allowLegacy = async () => {
    const config = configFor({
      type: 'any',
      children: [ownerCondition, { type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    await store.save(mainIdentity, { ...config, revision: (await store.read(mainIdentity))!.revision }, { userId: 28 });
  };

  pg('rolls back every field when one target is hidden or missing', async () => {
    for (const key of [102, 999]) {
      const ctx = await context({ values: { name: 'Edited', projects: [key], customers: [101] } });
      await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      await unchanged(ctx);
    }
  });
  for (const grant of [
    { fields: ['projects', 'name'] },
    { fields: ['projects', 'customers'], blacklist: ['customers'] },
  ])
    pg(`requires every submitted reference field in the source grant ${JSON.stringify(grant)}`, async () => {
      const ctx = await context({}, grant);
      const authorize = vi.fn(async () => null);
      await expect(handler.handle(ctx, actor(), authorize)).rejects.toThrow();
      expect(authorize).not.toHaveBeenCalled();
      await unchanged(ctx);
    });
  pg('filters scalar input and keeps source role conditions on the pre-edit record', async () => {
    const ctx = await context({}, { fields: ['projects', 'customers'], filter: { name: 'Owned' } });
    await execute(ctx);
    expect((await docs.model.findByPk(3))!.get('name')).toBe('Owned');
    expect(await linked('projects')).toEqual([101]);
    expect(await linked('customers')).toEqual([101]);
    const changed = await context(
      { values: { name: 'Submitted', projects: [103], customers: [103] } },
      { fields: ['projects', 'customers', 'name'], filter: { name: 'Owned' } },
    );
    await execute(changed);
    expect((await docs.model.findByPk(3))!.get('name')).toBe('Submitted');
  });
  pg('does not let visibility grant source writes', async () => {
    const ctx = await context({ filterByTk: 1 });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await unchanged(ctx, 1, 'Visible');
  });
  for (const kind of [
    'denied',
    'unreadable key',
    'wrong role',
    'other resource',
    'constrained lookup',
    'role condition',
  ])
    pg(`requires independent finalized target permission: ${kind}`, async () => {
      const ctx = await context();
      const authorize = async (collection: Collection) => {
        const related = await target(
          collection.name,
          collection.name === 'projects'
            ? kind === 'unreadable key'
              ? { fields: ['name'] }
              : kind === 'role condition'
                ? { filter: { name: 'Owned' } }
                : {}
            : {},
          collection.name === 'projects' && kind === 'constrained lookup' ? { filterByTk: 101 } : {},
        );
        if (collection.name === 'projects') {
          if (kind === 'denied') (related.permission as { can: unknown }).can = false;
          if (kind === 'wrong role') (related.permission as { can: { role: string } }).can.role = 'other';
          if (kind === 'other resource') Object.assign(related.action, { resourceName: 'customers' });
        }
        return related;
      };
      await expect(handler.handle(ctx, actor(), authorize)).rejects.toThrow();
      await unchanged(ctx);
    });
  pg('applies each registered relationship scope independently', async () => {
    Object.assign(docs.model.associations.projects, { scope: { name: 'Owned' } });
    const ctx = await context();
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    await unchanged(ctx);
  });
  pg('keeps separate scopes when two fields reference the same target collection', async () => {
    const through = db.collection({ name: 'document_otherProjects', timestamps: false });
    docs.setField('otherProjects', {
      type: 'belongsToMany',
      target: 'projects',
      through: through.name,
      foreignKey: 'documentId',
      otherKey: 'targetId',
      scope: { name: 'Owned' },
    });
    await db
      .getRepository('collections')
      .create({ values: { key: identity(through).collectionKey, name: through.name } });
    await db.sync();
    const denied = await context({ values: { projects: [101], otherProjects: [101] } });
    await expect(execute(denied)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    expect(await linked('projects')).toEqual([103]);
    expect(await linked('otherProjects')).toEqual([]);
    const allowed = await context({ values: { projects: [101], otherProjects: [103] } });
    await execute(allowed);
    expect(await linked('projects')).toEqual([101]);
    expect(await linked('otherProjects')).toEqual([103]);
  });
  pg('preserves and clears hidden old connections without authorizing old targets', async () => {
    for (const name of ['projects', 'customers'])
      await db.getCollection(`document_${name}`).model.update({ targetId: 102 }, { where: { documentId: 3 } });
    const ctx = await context({ values: { name: 'Edited', projects: [102], customers: [] } });
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, actor(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect(await linked('projects')).toEqual([102]);
    expect(await linked('customers')).toEqual([]);
    expect((await docs.model.findByPk(3))!.get('name')).toBe('Edited');
    expect(await db.getCollection('customers').model.count()).toBe(4);
  });
  pg('authorizes only the field with actual additions', async () => {
    const ctx = await context({ values: { projects: [103], customers: [101] } });
    const authorize = vi.fn((collection: Collection) => target(collection.name));
    await handler.handle(ctx, actor(), authorize);
    expect(authorize.mock.calls.map(([collection]) => collection.name)).toEqual(['customers']);
    expect(await linked('projects')).toEqual([103]);
    expect(await linked('customers')).toEqual([101]);
  });
  pg('claims one edited historical source while leaving both historical targets unchanged', async () => {
    await allowLegacy();
    const ctx = await context({ filterByTk: 5, values: { projects: [104], customers: [104] } });
    const write = vi.spyOn(docs.repository, 'update');
    await execute(ctx);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await docs.model.findByPk(5))!.get('tenantId')).toBe('B');
    for (const name of ['projects', 'customers']) {
      expect(await linked(name, 5)).toEqual([104]);
      expect((await db.getCollection(name).model.findByPk(104))!.get('tenantId')).toBeNull();
    }
  });
  pg('does not write or claim a completely unchanged historical source', async () => {
    await allowLegacy();
    const ctx = await context({
      filterByTk: 5,
      values: { name: 'Legacy', projects: [], customers: [], tenantId: null },
    });
    const write = vi.spyOn(docs.repository, 'update');
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, actor(), authorize);
    expect(write).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect((await docs.model.findByPk(5))!.get('tenantId')).toBeNull();
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
  });
  pg('keeps visible historical sources read-only without ownership authorization', async () => {
    const ctx = await context({ filterByTk: 5 });
    await expect(execute(ctx)).rejects.toThrow();
    await unchanged(ctx, 5, 'Legacy');
    expect((await docs.model.findByPk(5))!.get('tenantId')).toBeNull();
  });
  pg('does not claim historical sources when a later target fails authorization', async () => {
    await allowLegacy();
    const ctx = await context({ filterByTk: 5, values: { projects: [102], customers: [104] } });
    await expect(execute(ctx)).rejects.toThrow();
    await unchanged(ctx, 5, 'Legacy');
    expect((await docs.model.findByPk(5))!.get('tenantId')).toBeNull();
  });
  pg('captures every submitted array and actor before asynchronous target authorization', async () => {
    const ctx = await context();
    const auth = actor();
    await handler.handle(ctx, auth, async (collection) => {
      const raw = (
        ctx.permission as { rawParams: { values: { name: string; projects: number[]; customers: number[] } } }
      ).rawParams.values;
      raw.name = 'Forged';
      raw.projects[0] = 102;
      raw.customers[0] = 102;
      auth.tenantId = 'C';
      return target(collection.name);
    });
    expect((await docs.model.findByPk(3))!.get()).toMatchObject({ name: 'Edited', tenantId: 'B' });
    expect(await linked('projects')).toEqual([101]);
    expect(await linked('customers')).toEqual([101]);
  });
  for (const name of ['projects', 'customers'])
    pg(`captures and rechecks all relationship metadata during authorization: ${name}`, async () => {
      const ctx = await context();
      let calls = 0;
      await expect(
        handler.handle(ctx, actor(), async (collection) => {
          const related = await target(collection.name);
          if (++calls === (name === 'projects' ? 1 : 2))
            Object.assign(docs.model.associations[name], { scope: { name: 'Hidden' } });
          return related;
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      await unchanged(ctx);
    });
  pg('rechecks preparation after the final join verification query', async () => {
    const ctx = await context();
    const model = db.getCollection('document_projects').model;
    const original = model.findAll.bind(model);
    let reads = 0;
    vi.spyOn(model, 'findAll').mockImplementation(async (...args) => {
      const result = await original(...args);
      const options = args[0] as { hooks?: boolean; lock?: unknown };
      if (options.hooks === false && options.lock && ++reads === 2) adapter.release(ctx);
      return result;
    });
    await expect(execute(ctx)).rejects.toThrow();
    await unchanged(ctx);
  });
  pg('rolls back both link sets, the scalar patch and the claim when a later join hook fails', async () => {
    await allowLegacy();
    const ctx = await context({ filterByTk: 5 });
    const error = new Error('later join failed');
    const notified = vi.fn();
    db.getCollection('document_customers').model.addHook('afterBulkCreate', (_rows, options) => {
      options.transaction!.afterCommit(notified);
    });
    db.getCollection('document_projects').model.addHook('afterBulkCreate', () => {
      throw error;
    });
    await expect(execute(ctx)).rejects.toBe(error);
    expect(notified).not.toHaveBeenCalled();
    await unchanged(ctx, 5, 'Legacy');
    expect((await docs.model.findByPk(5))!.get('tenantId')).toBeNull();
  });
  pg('rejects a later hook changing an already-written link set', async () => {
    const ctx = await context();
    db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_rows, options) => {
      await db
        .getCollection('document_customers')
        .model.update({ targetId: 102 }, { where: { documentId: 3 }, transaction: options.transaction });
    });
    await expect(execute(ctx)).rejects.toThrow();
    await unchanged(ctx);
  });
  pg('rejects ownership changes caused by join hooks', async () => {
    const ctx = await context();
    db.getCollection('document_projects').model.addHook('afterBulkCreate', async (_rows, options) => {
      await docs.model.update({ tenantId: 'C' }, { where: { id: 3 }, transaction: options.transaction });
    });
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    await unchanged(ctx);
    expect((await docs.model.findByPk(3))!.get('tenantId')).toBe('B');
  });
  for (const value of [null, 101, [{ id: 101 }], [true], [Number.MAX_SAFE_INTEGER + 1]])
    it(`rejects malformed later reference input before SQL ${JSON.stringify(value)}`, async () => {
      const ctx = await context({ values: { projects: [101], customers: value } });
      const query = vi.spyOn(db.sequelize, 'query');
      const authorize = vi.fn(async () => null);
      await expect(handler.handle(ctx, actor(), authorize)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
    });

  for (const kind of ['sparse', 'symbol', 'prototype', 'accessor', 'oversized'])
    it(`rejects malformed later key arrays before SQL: ${kind}`, async () => {
      const ctx = await context({ values: { projects: [101], customers: [101, 103] } });
      // Corrupt the captured boundary after core middleware has normalized transport values.
      const value = (ctx.permission as { rawParams: { values: { customers: number[] } } }).rawParams.values.customers;
      if (kind === 'sparse') delete value[1];
      if (kind === 'symbol') Object.defineProperty(value, Symbol('extra'), { value: true });
      if (kind === 'prototype') Object.setPrototypeOf(value, Object.create(Array.prototype));
      if (kind === 'oversized') value.push(...Array.from({ length: 1000 }, (_, index) => index + 2000));
      if (kind === 'accessor') {
        Object.defineProperty(value, '0', {
          get() {
            throw new Error('must not invoke accessor');
          },
        });
      }
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(execute(ctx)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(query).not.toHaveBeenCalled();
    });

  pg('saves exactly twenty link fields and rejects the twenty-first before SQL', async () => {
    const values: Record<string, unknown> = { name: 'Edited', projects: [], customers: [] };
    for (let index = 2; index < 20; index++) {
      const name = `references${index}`;
      const { target } = await addRelation(name);
      await store.save(identity(target), { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
      values[name] = [];
    }
    await db.sync();
    const ctx = await context({ values });
    const authorize = vi.fn(async () => null);
    await handler.handle(ctx, actor(), authorize);
    expect(authorize).not.toHaveBeenCalled();
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    for (const name of Object.keys(values).filter((name) => name !== 'name')) expect(await linked(name)).toEqual([]);
    const { target } = await addRelation('references20');
    await store.save(identity(target), { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    const excessive = await context({ values: { ...values, references20: [] } });
    const query = vi.spyOn(db.sequelize, 'query');
    await expect(handler.handle(excessive, actor(), authorize)).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
    expect(query).not.toHaveBeenCalled();
  });

  pg('rejects two fields backed by the same physical join table', async () => {
    docs.setField('otherProjects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'document_projects',
      foreignKey: 'documentId',
      otherKey: 'targetId',
    });
    const ctx = await context({ values: { projects: [101], otherProjects: [103] } });
    const query = vi.spyOn(db.sequelize, 'query');
    await expect(execute(ctx)).rejects.toThrow('overlapping join tables');
    expect(query).not.toHaveBeenCalled();
  });

  for (const kind of [
    'null',
    'sparse',
    'symbol',
    'prototype',
    'duplicate',
    'twenty-one',
    'target prototype',
    'total limit',
  ])
    pg(`rejects malformed or excessive trusted link sets before SQL: ${kind}`, async () => {
      const ctx = await context();
      const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
      const service = new AccessManyToManyService(
        db,
        adapter,
        queries,
        new AccessMutationService(db, adapter, queries),
        new AccessReferenceService(db, adapter, queries),
      );
      const link = (name: string) => ({
        association: name,
        target: identity(db.getCollection(name)),
        through: identity(db.getCollection(`document_${name}`)),
        operation: 'set' as const,
        targetKeys: [101],
      });
      const links = [link('projects'), link('customers')];
      if (kind === 'sparse') delete links[1];
      if (kind === 'symbol') Object.defineProperty(links, Symbol('extra'), { value: true });
      if (kind === 'prototype') Object.setPrototypeOf(links, Object.create(Array.prototype));
      if (kind === 'duplicate') links[1] = link('projects');
      if (kind === 'twenty-one') links.push(...Array.from({ length: 19 }, () => link('projects')));
      if (kind === 'target prototype') Object.setPrototypeOf(links[1].targetKeys, Object.create(Array.prototype));
      if (kind === 'total limit') links[1].targetKeys = Array.from({ length: 10 }, (_, index) => index + 101);
      const sourceKeys = kind === 'total limit' ? Array.from({ length: 1000 }, (_, index) => index + 1) : [3];
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(
        service.withLinkSets(ctx, mainIdentity, actor(), { sourceKeys, links: kind === 'null' ? null! : links }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(query).not.toHaveBeenCalled();
    });
});
