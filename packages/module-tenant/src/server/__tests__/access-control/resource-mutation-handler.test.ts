import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessResourceMutationHandler } from '../../access-control/resource-mutation-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const actions = ['create', 'update', 'destroy', 'list', 'add', 'remove', 'set'];
const actor = { tenantId: 'B', roleName: 'editor', userId: 28 };

describe.skipIf(!postgresUrl)('unified internal resource mutations', () => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessResourceMutationHandler;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    ...(collection.name === 'documents'
      ? {}
      : { collectionName: collection.name, collectionKey: `${collection.name}-key` }),
  });
  const fields = () => [
    { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
    { name: 'tenantId', type: 'string' },
    { name: 'name', type: 'string' },
  ];

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl!);
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({ name: 'documents', timestamps: false, autoGenId: false, fields: fields() });
    db.collection({ name: 'projects', timestamps: false, fields: fields() });
    db.collection({ name: 'document_projects', timestamps: false });
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'document_projects',
      foreignKey: 'documentId',
      otherKey: 'projectId',
    });
    for (const [name, type] of [
      ['children', 'hasMany'],
      ['profiles', 'hasOne'],
    ]) {
      const child = db.collection({ name, timestamps: false, fields: fields() });
      docs.setField(name, { type, target: name, foreignKey: 'documentId' });
      child.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    }
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
    await db.getCollection('tenants').model.create({ id: 'B', enabled: true });
    const store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    for (const name of ['documents', 'projects', 'children', 'profiles', 'document_projects']) {
      const collection = db.getCollection(name);
      if (name !== 'documents')
        await db.getRepository('collections').create({
          values: { key: identity(collection).collectionKey, name },
        });
      if (name === 'document_projects') continue;
      const config = configFor(ownerCondition);
      config.rules.push({
        ...configFor(
          {
            type: 'compare',
            operator: 'eq',
            left: { type: 'field', path: 'name' },
            right: { type: 'literal', value: 'Visible' },
          },
          'visibility',
        ).rules[0],
        id: 'visible',
      });
      await store.save(identity(collection), { ...config, revision: 0 }, { userId: 28 });
    }
    await docs.model.bulkCreate([
      { id: 3, name: 'Owned', tenantId: 'B' },
      { id: 4, name: 'Visible', tenantId: 'H' },
      { id: 6, name: 'Delete me', tenantId: 'B' },
    ]);
    for (const name of ['projects', 'children', 'profiles'])
      await db.getCollection(name).model.bulkCreate([
        { id: 101, name: 'Owned', tenantId: 'B' },
        { id: 102, name: 'Visible', tenantId: 'H' },
        { id: 103, name: 'Hidden', tenantId: 'C' },
      ]);
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    handler = new AccessResourceMutationHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
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

  async function context(resourceName: string, actionName: string, params: object = {}, grant = {}, source?: string) {
    const acl = new ACL();
    for (const action of actions) acl.setAvailableAction(action, {});
    acl.define({ role: 'editor' }).grantAction(`${resourceName}:${actionName}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: resourceName, actions: Object.fromEntries(actions.map((name) => [name, {}])) });
    const action = resourcer.getAction(resourceName, actionName).clone();
    Object.assign(action, {
      resourceName: source === undefined ? resourceName : `documents.${resourceName}`,
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
      state: { currentRole: 'editor', currentUser: { id: 28 } },
      get: () => '+08:00',
      logger: { info: vi.fn() },
      throw: (status: number) => {
        throw new Error(String(status));
      },
    };
    await adapter.prepare(
      ctx,
      ['documents', 'projects', 'children', 'profiles', 'document_projects'].map((name) =>
        identity(db.getCollection(name)),
      ),
    );
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  const root = (values: object, key = 3) => context('documents', 'update', { filterByTk: key, values });
  const decisions = () => ({
    read: (collection: Collection) => context(collection.name, 'list'),
    update: (collection: Collection) => context(collection.name, 'update'),
    source: (collection: Collection, operation: 'add' | 'remove' | 'set') => context(collection.name, operation),
  });
  const run = (ctx: Awaited<ReturnType<typeof context>>, grants = decisions()) => handler.handle(ctx, actor, grants);
  const row = async (name = 'documents', id = 3) => (await db.getCollection(name).model.findByPk(id))?.toJSON();
  const links = async () =>
    (await db.getCollection('document_projects').model.findAll()).map((record) => Number(record.get('projectId')));

  it('creates scalar records and assigns the current owner', async () => {
    const ctx = await context('documents', 'create', { values: { name: 'New' } });
    await run(ctx);
    expect(ctx.body).toEqual({ keys: [expect.any(Number)], affected: 1 });
    expect(await row('documents', (ctx.body as { keys: number[] }).keys[0])).toMatchObject({
      name: 'New',
      tenantId: 'B',
    });
  });
  it('creates records with both supported reference types', async () => {
    const ctx = await context('documents', 'create', { values: { name: 'New', project: 102, projects: [102] } });
    await run(ctx);
    expect(await row('documents', (ctx.body as { keys: number[] }).keys[0])).toMatchObject({
      name: 'New',
      tenantId: 'B',
      projectId: 102,
    });
    expect(await links()).toEqual([102]);
    expect(await row('projects', 102)).toMatchObject({ tenantId: 'H' });
  });
  it('updates scalar records without consulting related decisions', async () => {
    const read = vi.fn(async () => null);
    const update = vi.fn(async () => null);
    const source = vi.fn(async () => null);
    const ctx = await root({ name: 'Edited' });
    await run(ctx, { read, update, source });
    expect(await row()).toMatchObject({ name: 'Edited', tenantId: 'B' });
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
    for (const callback of [read, update, source]) expect(callback).not.toHaveBeenCalled();
  });
  it('deletes through the scalar service', async () => {
    const ctx = await context('children', 'destroy', { filterByTk: 101 });
    await run(ctx);
    expect(await row('children', 101)).toBeUndefined();
    expect(ctx.body).toEqual({ keys: [101], affected: 1 });
  });
  it('dispatches explicitly selected scalar updates without related authorization', async () => {
    const ctx = await context('documents', 'update', { filterByTk: [6, 3], values: { name: 'Edited' } });
    const read = vi.fn(async () => null);
    const update = vi.fn(async () => null);
    const source = vi.fn(async () => null);
    await run(ctx, { read, update, source });
    expect(ctx.body).toEqual({ keys: [3, 6], affected: 2 });
    for (const id of [3, 6]) expect(await row('documents', id)).toMatchObject({ name: 'Edited', tenantId: 'B' });
    for (const callback of [read, update, source]) expect(callback).not.toHaveBeenCalled();
  });
  it('dispatches explicitly selected deletes through the scalar service', async () => {
    await db.getCollection('children').model.update({ tenantId: 'B' }, { where: { id: 102 } });
    const ctx = await context('children', 'destroy', { filterByTk: [102, 101] });
    await run(ctx);
    expect(ctx.body).toEqual({ keys: [101, 102], affected: 2 });
    for (const id of [101, 102]) expect(await row('children', id)).toBeUndefined();
  });
  it('preserves the existing refusal of cascaded deletion', async () => {
    const ctx = await context('documents', 'destroy', { filterByTk: 6 });
    await expect(run(ctx)).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    expect(await row('documents', 6)).toMatchObject({ name: 'Delete me' });
    expect(ctx.body).toBe('unchanged');
  });
  it.each([{ project: 102 }, { projects: [102] }, { project: 102, projects: [102] }])(
    'updates scalar fields with readable references %j',
    async (values) => {
      const ctx = await root({ name: 'Edited', ...values });
      await run(ctx, { ...decisions(), update: async () => null, source: async () => null });
      expect(await row()).toMatchObject({ name: 'Edited', tenantId: 'B' });
      if ('project' in values) expect((await row()).projectId).toBe(102);
      if ('projects' in values) expect(await links()).toEqual([102]);
      expect(await row('projects', 102)).toMatchObject({ tenantId: 'H', name: 'Visible' });
    },
  );
  it.each(['children', 'profiles'])('updates scalar fields and a %s selection', async (name) => {
    const ctx = await root({ name: 'Edited', [name]: name === 'children' ? [101] : 101 });
    await run(ctx, { ...decisions(), source: async () => null });
    expect(await row(name, 101)).toMatchObject({ documentId: 3, tenantId: 'B' });
    expect(await row()).toMatchObject({ name: 'Edited' });
    expect(ctx.body).toEqual({ keys: [3], affected: 1 });
  });
  it.each([{ project: null }, { projects: [] }, { children: [] }, { profiles: null }])(
    'retains no-op results without repository writes %j',
    async (values) => {
      const write = vi.spyOn(docs.repository, 'update');
      const ctx = await root({ name: 'Owned', ...values });
      await run(ctx);
      expect(write).not.toHaveBeenCalled();
      expect(ctx.body).toEqual({ keys: [], affected: 0 });
      expect(await row()).toMatchObject({ name: 'Owned', tenantId: 'B' });
    },
  );
  it.each(['projects', 'children', 'profiles'])('dispatches concrete %s set and remove actions', async (name) => {
    const ctx = await context(name, 'set', { values: name === 'profiles' ? 101 : [101] }, {}, '3');
    await run(ctx);
    if (name === 'projects') expect(await links()).toEqual([101]);
    else expect(await row(name, 101)).toMatchObject({ documentId: 3 });
    const remove = await context(name, 'remove', name === 'profiles' ? {} : { values: [101] }, {}, '3');
    await run(remove);
    if (name === 'projects') expect(await links()).toEqual([]);
    else expect((await row(name, 101)).documentId).toBeNull();
  });
  it.each(['projects', 'children'])('dispatches concrete %s add actions', async (name) => {
    await run(await context(name, 'add', { values: [101] }, {}, '3'));
    if (name === 'projects') expect(await links()).toEqual([101]);
    else expect(await row(name, 101)).toMatchObject({ documentId: 3 });
  });
  it.each(['projects', 'children', 'profiles'])('does not write on repeated concrete %s set', async (name) => {
    const params = { values: name === 'profiles' ? 101 : [101] };
    await run(await context(name, 'set', params, {}, '3'));
    const sourceWrite = vi.spyOn(docs.repository, 'update');
    const targetWrite = vi.spyOn(db.getCollection(name).repository, 'update');
    const ctx = await context(name, 'set', params, {}, '3');
    await run(ctx);
    expect(sourceWrite).not.toHaveBeenCalled();
    expect(targetWrite).not.toHaveBeenCalled();
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
  });
  it('does not write on an empty HasOne remove', async () => {
    const write = vi.spyOn(docs.repository, 'update');
    const ctx = await context('profiles', 'remove', {}, {}, '3');
    await run(ctx);
    expect(write).not.toHaveBeenCalled();
    expect(ctx.body).toEqual({ keys: [], affected: 0 });
  });
  it.each([{ project: 103 }, { projects: [103] }, { children: [103] }, { profiles: 103 }])(
    'does not fall back after a target denial %j',
    async (values) => {
      const ctx = await root({ name: 'Denied', ...values });
      await expect(run(ctx)).rejects.toMatchObject({ code: expect.any(String) });
      expect(await row()).toMatchObject({ name: 'Owned', projectId: null });
      expect(await links()).toEqual([]);
      expect(ctx.body).toBe('unchanged');
    },
  );
  it.each(['children', 'profiles'])('requires child update decisions for %s', async (name) => {
    const ctx = await root({ name: 'Denied', [name]: name === 'children' ? [101] : 101 });
    await expect(run(ctx, { ...decisions(), update: async () => null })).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect((await row()).name).toBe('Owned');
  });
  it('requires an independent source decision on concrete actions', async () => {
    const ctx = await context('projects', 'set', { values: [101] }, {}, '3');
    await expect(run(ctx, { ...decisions(), source: async () => null })).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(await links()).toEqual([]);
  });
  it.each([{ name: 'Denied' }, { project: 102 }, { children: [101] }])(
    'does not turn source visibility into write permission %j',
    async (values) => {
      await expect(run(await root(values, 4))).rejects.toMatchObject({ code: expect.any(String) });
      expect((await row('documents', 4)).name).toBe('Visible');
    },
  );
  it.each([
    { children: [101], project: 101 },
    { profiles: 101, projects: [101] },
    { children: [101], profiles: 101 },
    { projectId: 101 },
    { children: [{ id: 101 }] },
    { project: { id: 101 } },
    { unknown: 1 },
  ])('rejects unsupported root shapes without partially saving %j', async (values) => {
    const ctx = await root({ name: 'Denied', ...values });
    await expect(run(ctx)).rejects.toMatchObject({ code: expect.any(String) });
    expect((await row()).name).toBe('Owned');
    expect(await links()).toEqual([]);
    expect(ctx.body).toBe('unchanged');
  });
  it.each(['projects', 'children', 'profiles'])('rejects /_/ as a mutation source for %s', async (name) => {
    const ctx = await context(name, 'set', { values: name === 'profiles' ? 101 : [101] }, {}, '_');
    await expect(run(ctx)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(ctx.body).toBe('unchanged');
  });
  it('does not invoke action accessors while routing', async () => {
    const ctx = await root({ name: 'Denied' });
    const getter = vi.fn(() => 'documents');
    Object.defineProperty(ctx.action, 'resourceName', { get: getter });
    await expect(run(ctx)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    { resourceName: 'documents.unknown' },
    { resourceName: 'documents.children.document' },
    { resourceName: 'documents.project', actionName: 'set', sourceId: '3', resourceOf: '3' },
    { actionName: 'add' },
    { sourceId: '3' },
    { resourceName: '__proto__' },
  ])('rejects unsupported action descriptors %j', async (descriptor) => {
    const ctx = await root({ name: 'Denied' });
    Object.assign(ctx.action, descriptor);
    await expect(run(ctx)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect((await row()).name).toBe('Owned');
    expect(ctx.body).toBe('unchanged');
  });
  it.each([{ project: 102 }, { projects: [102] }, { children: [101] }, { profiles: 101 }])(
    'retains source relationship field grants %j',
    async (values) => {
      const ctx = await context(
        'documents',
        'update',
        { filterByTk: 3, values: { name: 'Denied', ...values } },
        { fields: ['name'] },
      );
      await expect(run(ctx)).rejects.toMatchObject({ code: expect.any(String) });
      expect((await row()).name).toBe('Owned');
      expect(ctx.body).toBe('unchanged');
    },
  );
  it.each(['name', 'children'])('rejects accessors in raw values for %s without invoking them', async (name) => {
    const ctx = await root({ name: 'Denied' });
    const values = (ctx.permission as { rawParams: { values: object } }).rawParams.values;
    const getter = vi.fn(() => (name === 'children' ? [101] : 'Denied'));
    Object.defineProperty(values, name, { get: getter, enumerable: true });
    await expect(run(ctx)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(getter).not.toHaveBeenCalled();
    expect((await row()).name).toBe('Owned');
  });
  it.each(['children', 'projects'])('does not normalize malformed %s arrays into accepted selections', async (name) => {
    const ctx = await root({ [name]: [101] });
    const values = (ctx.permission as { rawParams: { values: Record<string, number[]> } }).rawParams.values;
    Object.setPrototypeOf(values[name], null);
    await expect(run(ctx)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect((await row('children', 101)).documentId).toBeNull();
  });
  it('rolls back a routed child failure together with source fields', async () => {
    db.getCollection('children').model.addHook('afterUpdate', () => {
      throw new Error('child hook failed');
    });
    const ctx = await root({ name: 'Denied', children: [101] });
    await expect(run(ctx)).rejects.toThrow('child hook failed');
    expect((await row()).name).toBe('Owned');
    expect((await row('children', 101)).documentId).toBeNull();
    expect(ctx.body).toBe('unchanged');
  });
});
