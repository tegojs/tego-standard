import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, type Collection, type Context } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessRootResourceRuntime } from '../../access-control/root-resource-runtime';
import { grantStoredScope, seedAclScopes } from './acl-database';
import { configStore, mainIdentity, seedConfigStore } from './config-database';
import { seedDatabase } from './database';
import { configFor, exampleConfig } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;

/** Isolated HTTP/ACL integration, not an authentication or production plugin activation fixture. */
describe.skipIf(!coreAvailable)('tenant access model over real HTTP resources', () => {
  let app: MockServer;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: ReturnType<typeof configStore>;
  let unregister: (() => void) | undefined;
  let lastContext: Context | undefined;
  let principal: { tenantId: string; roleName: string; userId: number };
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: `${collection.name}-key`,
  });

  beforeEach(async () => {
    lastContext = undefined;
    app = mockServer({
      acl: false,
      registerActions: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      resourcer: { prefix: '/api' },
    });
    const db = app.db;
    await seedConfigStore(db);
    await seedAclScopes(db);
    await seedDatabase(db);
    db.collection({
      name: 'documents',
      tableName: 'access_documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer', defaultValue: 10 },
      ],
    });
    db.collection({
      name: 'participants',
      tableName: 'access_participants',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'documentId', type: 'integer', field: 'document_id' },
        { name: 'businessTenant', type: 'string', field: 'business_tenant' },
        { name: 'canView', type: 'boolean', field: 'can_view' },
      ],
    });
    db.getCollection('documents').setField('participants', {
      type: 'hasMany',
      target: 'participants',
      foreignKey: 'documentId',
      onDelete: 'RESTRICT',
    });
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.bulkCreate([
      { id: 'H', enabled: true },
      { id: 'B', parentId: 'H', enabled: true },
      { id: 'C', parentId: 'H', enabled: true },
    ]);
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    acl = new CoreACL();
    app.mainDataSource.acl = acl;
    await grantStoredScope(db, acl);
    acl.setAvailableAction('view', { aliases: ['get', 'list', 'count'] });
    store = configStore(db);
    await store.save(mainIdentity, { ...exampleConfig, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
    const runtime = new AccessRootResourceRuntime(
      db,
      adapter,
      (collection) => (collection.name === 'documents' ? identity(collection) : undefined),
      (collection) => accessCollectionKey(identity(collection)),
      acl.middleware(),
    );
    principal = { tenantId: 'B', roleName: 'member', userId: 28 };

    // These are server-authenticated fixture values, never request headers or action values.
    app.resourcer.use(
      async (ctx, next) => {
        const actor = { ...principal };
        ctx.state.currentRole = actor.roleName;
        ctx.state.currentTenant = { id: actor.tenantId };
        ctx.state.accessTestActor = actor;
        lastContext = ctx;
        await runtime.prepare(ctx, actor, [mainIdentity], next);
      },
      { tag: 'access-test-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'access-test-acl', after: 'access-test-preparation' });
    app.resourcer.use((ctx, next) => runtime.dispatch(ctx, next), {
      tag: 'access-test-dispatch',
      after: 'access-test-acl',
    });
    app.resourcer.define({
      name: 'documents',
      actions: Object.fromEntries(
        ['list', 'get', 'count', 'create', 'update', 'destroy'].map((action) => [action, {}]),
      ),
    });
  });

  afterEach(async () => {
    if (lastContext) expect(() => adapter.configuration(lastContext, mainIdentity)).toThrow();
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  it('fails closed when a selected tenant-scoped collection disables ownership enforcement', async () => {
    const collection = app.db.getCollection('documents');
    collection.options.tenancy = 'tenantScoped';
    const target = identity(collection);
    const current = (await store.read(target))!;
    await store.save(target, { ...current, ownership: { enabled: false }, rules: [] }, { userId: 28 });

    const response = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'] });

    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it('retains effective tenant ownership when saved ownership rules are unrestricted', async () => {
    const collection = app.db.getCollection('documents');
    collection.options.tenancy = 'tenantScoped';
    const target = identity(collection);
    const current = (await store.read(target))!;
    await store.save(
      target,
      {
        ...current,
        ownership: { enabled: true },
        rules: [
          {
            id: 'unrestricted-ownership',
            name: 'Unrestricted ownership',
            category: 'ownership',
            enabled: true,
            subject: { type: 'constant', value: true },
            condition: { type: 'constant', value: true },
          },
        ],
      },
      { userId: 28 },
    );

    const response = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 3 }]);
  });

  it('includes descendants but excludes unrelated owners when inherited ownership rules are unrestricted', async () => {
    const collection = app.db.getCollection('documents');
    collection.options.tenancy = 'tenantInherited';
    const target = identity(collection);
    const current = (await store.read(target))!;
    await app.db.getRepository('tenants').create({ values: { id: 'D', parentId: 'B', enabled: true } });
    await app.db.getRepository('documents').create({
      values: { id: 7, tenantId: 'D', amount: 700, name: 'D7' },
    });
    await store.save(
      target,
      {
        ...current,
        ownership: { enabled: true },
        rules: [
          {
            id: 'unrestricted-ownership',
            name: 'Unrestricted ownership',
            category: 'ownership',
            enabled: true,
            subject: { type: 'constant', value: true },
            condition: { type: 'constant', value: true },
          },
        ],
      },
      { userId: 28 },
    );

    const response = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 3 }, { id: 7 }]);
  });

  it('retains only explicitly allowed legacy rows within the tenant ownership boundary', async () => {
    const collection = app.db.getCollection('documents');
    collection.options.tenancy = 'tenantScoped';
    collection.options.legacyDataTenantIds = ['B'];
    const target = identity(collection);
    const current = (await store.read(target))!;
    await store.save(
      target,
      {
        ...current,
        ownership: { enabled: true },
        rules: [
          {
            id: 'unrestricted-ownership',
            name: 'Unrestricted ownership',
            category: 'ownership',
            enabled: true,
            subject: { type: 'constant', value: true },
            condition: { type: 'constant', value: true },
          },
          {
            id: 'unrestricted-visibility',
            name: 'Unrestricted visibility',
            category: 'visibility',
            enabled: true,
            subject: { type: 'constant', value: true },
            condition: { type: 'constant', value: true },
          },
        ],
      },
      { userId: 28 },
    );

    const response = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 3 }, { id: 5 }]);

    principal = { ...principal, tenantId: 'C' };
    const unrelatedTenant = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(unrelatedTenant.status).toBe(200);
    expect(unrelatedTenant.body.data).toEqual([{ id: 4 }]);
  });

  it('returns matching paginated, detail and count responses over actual resource routes', async () => {
    const list = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'], pageSize: 1 });
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ data: [{ id: 1 }], meta: { count: 2, page: 1, pageSize: 1, totalPage: 2 } });
    const next = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'], pageSize: 1, page: 2 });
    expect(next.status).toBe(200);
    expect(next.body.data).toEqual([{ id: 3 }]);
    const detail = await app
      .agent()
      .resource('documents')
      .get({ fields: ['id'], filterByTk: 1 });
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({ data: { id: 1 } });
    const count = await app.agent().resource('documents').count();
    expect(count.status).toBe(200);
    expect(count.body).toEqual({ data: 2 });
  });

  it('keeps independent requests under their server authenticated tenant', async () => {
    const b = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(b.status).toBe(200);
    expect(b.body.data).toEqual([{ id: 1 }, { id: 3 }]);
    principal = { ...principal, tenantId: 'C' };
    const c = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(c.status).toBe(200);
    expect(c.body.data).toEqual([{ id: 4 }, { id: 6 }]);
  });

  it('retains the original query filter after scope delegation', async () => {
    const response = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], filter: { id: 3 } });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 3 }]);
    expect(response.body.meta.count).toBe(1);
  });

  it('does not return a hidden record through its actual detail route', async () => {
    const response = await app
      .agent()
      .resource('documents')
      .get({ fields: ['id'], filterByTk: 4 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: null });
  });

  it('retains custom role restrictions in HTTP results', async () => {
    await grantStoredScope(app.db, acl, { key: 'custom', scope: { amount: { $gte: 200 } } });
    const response = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 3 }]);
    expect(response.body.meta.count).toBe(1);
  });

  it('does not use model visibility to grant a role missing the operation', async () => {
    acl.define({ role: 'no-read' });
    principal = { ...principal, roleName: 'no-read' };
    const response = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  });

  it('rejects a disallowed filter instead of falling back to the ordinary repository handler', async () => {
    acl.addFixedParams('documents', 'list', () => ({ fields: ['id'] }));
    const response = await app
      .agent()
      .resource('documents')
      .list({ filter: { name: 'D1' } });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it('reads a new committed configuration on the next HTTP request', async () => {
    const before = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual([{ id: 1 }, { id: 3 }]);
    const saved = await store.read(mainIdentity);
    await store.save(mainIdentity, { ...saved!, rules: [] }, { userId: 28 });
    const after = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'] });
    expect(after.status).toBe(200);
    expect(after.body.data).toEqual([]);
    expect(after.body.meta.count).toBe(0);
    const count = await app.agent().resource('documents').count();
    expect(count.status).toBe(200);
    expect(count.body).toEqual({ data: 0 });
  });

  it('retains the original ACL scope when delegation is explicitly unregistered', async () => {
    unregister!();
    unregister = undefined;
    const response = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 3 }]);
    expect(response.body.meta.count).toBe(1);
  });

  it('leaves unselected resources on their ordinary core handlers', async () => {
    const ordinary = app.db.collection({
      name: 'ordinaryDocuments',
      timestamps: false,
      fields: [{ name: 'tenantId', type: 'string' }],
    });
    await ordinary.model.sync();
    await ordinary.model.bulkCreate([
      { id: 1, tenantId: 'B' },
      { id: 2, tenantId: 'C' },
    ]);
    acl.getRole('member')!.grantAction('ordinaryDocuments:list', { fields: ['id'] });
    app.resourcer.define({ name: 'ordinaryDocuments', actions: { list: {} } });
    const response = await app
      .agent()
      .resource('ordinaryDocuments')
      .list({ fields: ['id'], sort: ['id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('keeps an unconfigured selected table on its original ACL and core handler', async () => {
    const metadata = await app.db.getRepository('collections').findOne({ filterByTk: 'documents' });
    const options = { ...metadata!.getDataValue('options') };
    delete options.tenantAccess;
    await metadata!.update({ options }, { hooks: false });
    expect(await store.read(mainIdentity)).toBeNull();
    const response = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 3 }]);
  });

  it('blocks unsupported selected actions before their ordinary handler can write', async () => {
    acl.getRole('member')!.grantAction('documents:archive', {});
    app.resourcer.define({
      name: 'documents',
      actions: {
        archive: async (ctx) => {
          await app.db.getRepository('documents').update({ filterByTk: 3, values: { name: 'Unprotected archive' } });
          ctx.body = { archived: true };
        },
      },
    });
    const before = (await app.db.getCollection('documents').model.findByPk(3))!.get('name');
    const response = await app.agent().resource('documents').archive();
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data.archived');
    expect((await app.db.getCollection('documents').model.findByPk(3))!.get('name')).toBe(before);
  });

  async function grantMutation(operation: 'create' | 'update' | 'destroy', filter?: Record<string, unknown>) {
    const scopeRepo = app.db.getRepository('dataSourcesRolesResourcesScopes');
    const scope = filter
      ? await scopeRepo.create({ values: { key: `custom-${operation}`, dataSourceKey: 'main', scope: filter } })
      : await scopeRepo.findOne({ filter: { key: 'tenant', dataSourceKey: 'main' } });
    const action = await app.db.getRepository('dataSourcesRolesResourcesScopesActions').create({
      values: { name: operation, fields: operation === 'destroy' ? [] : ['name'], scopeId: scope.get('id') },
    });
    await action.writeToACL({
      acl,
      role: acl.getRole('member'),
      resourceName: 'documents',
      associationFieldsActions: {},
      grantHelper: {},
    });
  }

  const record = async (id: number) => (await app.db.getCollection('documents').model.findByPk(id))?.get();

  describe('filter-only HTTP mutations', () => {
    const request = (operation: 'update' | 'destroy', filter: object) =>
      supertest(app.callback())
        .post(`/api/documents:${operation}`)
        .query({ filter: JSON.stringify(filter) })
        .send(operation === 'update' ? { name: 'Changed', amount: 999 } : {});

    it.each(['update', 'destroy'] as const)('intersects actual %s, list and ownership scopes', async (operation) => {
      await grantMutation(operation, { amount: { $gte: 200 } });
      await app.db.getCollection('documents').model.bulkCreate([
        { id: 7, tenantId: 'B', name: 'D3', amount: 350 },
        { id: 8, tenantId: 'B', name: 'Other', amount: 350 },
        { id: 9, tenantId: 'B', name: 'D3', amount: 150 },
      ]);
      const stored = await grantStoredScope(app.db, acl, { key: 'conditional-list', scope: { name: 'D3' } });
      await stored.action.update({ fields: ['id', 'name', 'amount'] });
      await stored.action.writeToACL({
        acl,
        role: acl.getRole('member'),
        resourceName: 'documents',
        associationFieldsActions: {},
        grantHelper: {},
      });
      const response = await request(operation, { amount: { $gte: 100 } });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: { keys: [3, 7], affected: 2 } });
      if (operation === 'update') {
        expect(await record(3)).toMatchObject({ name: 'Changed', amount: 300, tenantId: 'B' });
        expect(await record(7)).toMatchObject({ name: 'Changed', amount: 350, tenantId: 'B' });
      } else {
        expect(await record(3)).toBeUndefined();
        expect(await record(7)).toBeUndefined();
      }
      expect(await record(1)).toMatchObject({ name: 'D1', tenantId: 'H' });
      expect(await record(4)).toMatchObject({ name: 'D4', tenantId: 'C' });
      expect(await record(8)).toMatchObject({ name: 'Other' });
      expect(await record(9)).toMatchObject({ name: 'D3', amount: 150 });
    });

    it.each(['update', 'destroy'] as const)(
      'returns a committed empty HTTP %s result without V-only writes',
      async (operation) => {
        await grantMutation(operation);
        const response = await request(operation, { id: 1 });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: { keys: [], affected: 0 } });
        expect(await record(1)).toMatchObject({ name: 'D1', tenantId: 'H' });
      },
    );

    it.each(['operation', 'read-field', 'list-operation'])(
      'rejects missing %s authorization before selecting',
      async (boundary) => {
        if (boundary !== 'operation') await grantMutation('update');
        if (boundary === 'read-field') acl.addFixedParams('documents', 'list', () => ({ fields: ['id'] }));
        if (boundary === 'list-operation') acl.getRole('member').revokeAction('documents:view');
        const response = await request('update', { name: 'D3' });
        expect(response.status).toBe(boundary === 'read-field' ? 400 : 403);
        expect(response.body).not.toHaveProperty('data');
        expect(await record(3)).toMatchObject({ name: 'D3', tenantId: 'B' });
      },
    );

    it('rolls back all HTTP matches after a later write hook fails', async () => {
      await grantMutation('update');
      await app.db.getCollection('documents').model.create({ id: 7, tenantId: 'B', name: 'D3', amount: 300 });
      let observed = false;
      app.db.on('documents.afterUpdate', async (row, options) => {
        if (row.get('id') !== 7) return;
        const first = await app.db.getCollection('documents').model.findByPk(3, { transaction: options.transaction });
        expect(first?.get('name')).toBe('Changed');
        observed = true;
        throw new Error('Late HTTP matching failure');
      });
      const response = await request('update', { name: 'D3' });
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('data');
      expect(observed).toBe(true);
      expect(await record(3)).toMatchObject({ name: 'D3' });
      expect(await record(7)).toMatchObject({ name: 'D3' });
    });
  });

  it('commits an owned record update using actual write field permissions', async () => {
    await grantMutation('update');
    const response = await app
      .agent()
      .resource('documents')
      .update({ filterByTk: 3, values: { name: 'Changed', amount: 999 } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await record(3)).toMatchObject({ name: 'Changed', amount: 300, tenantId: 'B' });
  });

  it('commits deletion of an owned record', async () => {
    await grantMutation('destroy');
    const response = await app.agent().resource('documents').destroy({ filterByTk: 3 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await record(3)).toBeUndefined();
  });

  it.each(['update', 'destroy'] as const)('accepts filter={} on an actual keyed HTTP %s', async (operation) => {
    await grantMutation(operation, { name: 'D3' });
    const response = await supertest(app.callback())
      .post(`/api/documents:${operation}?filterByTk=3&filter=%7B%7D`)
      .send(operation === 'update' ? { name: 'Changed', amount: 999 } : {});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    if (operation === 'update') expect(await record(3)).toMatchObject({ name: 'Changed', amount: 300, tenantId: 'B' });
    else expect(await record(3)).toBeUndefined();
  });

  it.each(['update', 'destroy'] as const)('does not let V-only access authorize %s', async (operation) => {
    await grantMutation(operation);
    const visible = await app
      .agent()
      .resource('documents')
      .get({ filterByTk: 1, fields: ['id'] });
    expect(visible.status).toBe(200);
    expect(visible.body).toEqual({ data: { id: 1 } });
    const response = await app
      .agent()
      .resource('documents')
      [operation]({
        filterByTk: 1,
        ...(operation === 'update' ? { values: { name: 'Forbidden' } } : {}),
      });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await record(1)).toMatchObject({ name: 'D1', tenantId: 'H' });
  });

  it('does not allow model ownership to grant a missing update operation', async () => {
    const response = await app
      .agent()
      .resource('documents')
      .update({ filterByTk: 3, values: { name: 'Forbidden' } });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await record(3)).toMatchObject({ name: 'D3', tenantId: 'B' });
  });

  it('rejects ordinary ownership transfers even if tenantId is not a writable field', async () => {
    await grantMutation('update');
    const response = await app
      .agent()
      .resource('documents')
      .update({ filterByTk: 3, values: { name: 'Forbidden', tenantId: 'C' } });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await record(3)).toMatchObject({ name: 'D3', tenantId: 'B' });
  });

  it('rejects the entire HTTP selection when one record is outside G', async () => {
    await grantMutation('update');
    const response = await supertest(app.callback())
      .post('/api/documents:update?filterByTk[]=3&filterByTk[]=1')
      .send({ name: 'Forbidden' });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await record(3)).toMatchObject({ name: 'D3', tenantId: 'B' });
    expect(await record(1)).toMatchObject({ name: 'D1', tenantId: 'H' });
  });

  it('rolls back an actual repository write if a hook fails', async () => {
    await grantMutation('update');
    app.db.on('documents.afterUpdate', async () => {
      throw new Error('HTTP mutation rollback fixture');
    });
    const response = await app
      .agent()
      .resource('documents')
      .update({ filterByTk: 3, values: { name: 'Uncommitted' } });
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('data');
    expect(await record(3)).toMatchObject({ name: 'D3', tenantId: 'B' });
  });

  it('returns success when a committed update exits its original role range', async () => {
    await grantMutation('update', { name: 'D3' });
    const response = await app
      .agent()
      .resource('documents')
      .update({ filterByTk: 3, values: { name: 'Submitted' } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [3], affected: 1 } });
    expect(await record(3)).toMatchObject({ name: 'Submitted', tenantId: 'B' });
    const again = await app
      .agent()
      .resource('documents')
      .update({ filterByTk: 3, values: { name: 'Forbidden' } });
    expect(again.status).toBe(403);
    expect(await record(3)).toMatchObject({ name: 'Submitted', tenantId: 'B' });
  });

  it('claims an allowed legacy record on its first committed HTTP edit', async () => {
    await grantMutation('update');
    const saved = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      {
        ...saved,
        rules: [
          ...saved.rules,
          {
            ...configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }).rules[0],
            id: 'claim-legacy',
          },
        ],
      },
      { userId: 28 },
    );
    const response = await app
      .agent()
      .resource('documents')
      .update({ filterByTk: 5, values: { name: 'Claimed', tenantId: null } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [5], affected: 1 } });
    expect(await record(5)).toMatchObject({ name: 'Claimed', tenantId: 'B' });
    principal = { ...principal, tenantId: 'C' };
    const hidden = await app
      .agent()
      .resource('documents')
      .get({ filterByTk: 5, fields: ['id'] });
    expect(hidden.status).toBe(200);
    expect(hidden.body).toEqual({ data: null });
  });

  it.each(['B', 'C'])('creates with server tenant %s, permitted fields and model defaults', async (tenantId) => {
    await grantMutation('create');
    principal = { ...principal, tenantId };
    const response = await app
      .agent()
      .resource('documents')
      .create({ values: { name: 'Created', amount: 999 } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [7], affected: 1 } });
    expect(await record(7)).toEqual({ id: 7, name: 'Created', amount: 10, tenantId });
    const detail = await app
      .agent()
      .resource('documents')
      .get({ filterByTk: 7, fields: ['id'] });
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual({ data: { id: 7 } });
    principal = { ...principal, tenantId: tenantId === 'B' ? 'C' : 'B' };
    const hidden = await app
      .agent()
      .resource('documents')
      .get({ filterByTk: 7, fields: ['id'] });
    expect(hidden.status).toBe(200);
    expect(hidden.body).toEqual({ data: null });
  });

  it('does not grant create through ownership alone', async () => {
    const response = await app
      .agent()
      .resource('documents')
      .create({ values: { name: 'Forbidden' } });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await app.db.getCollection('documents').model.count()).toBe(6);
  });

  it('does not use visibility to authorize a new record', async () => {
    await grantMutation('create');
    const saved = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      {
        ...configFor({ type: 'constant', value: true }, 'visibility'),
        revision: saved.revision,
      },
      { userId: 28 },
    );
    const response = await app
      .agent()
      .resource('documents')
      .create({ values: { name: 'Forbidden' } });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await app.db.getCollection('documents').model.count()).toBe(6);
  });

  it('rejects a forged create owner outside the field whitelist', async () => {
    await grantMutation('create');
    const response = await app
      .agent()
      .resource('documents')
      .create({ values: { name: 'Forbidden', tenantId: 'C' } });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await app.db.getCollection('documents').model.count()).toBe(6);
  });

  it('checks create role conditions against persisted defaults', async () => {
    await grantMutation('create', { amount: { $gte: 20 } });
    const response = await app
      .agent()
      .resource('documents')
      .create({ values: { name: 'Forbidden', amount: 999 } });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await app.db.getCollection('documents').model.count()).toBe(6);
  });

  it('commits a create matching its role conditions and ownership', async () => {
    await grantMutation('create', { amount: 10 });
    const response = await app
      .agent()
      .resource('documents')
      .create({ values: { name: 'Allowed' } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { keys: [7], affected: 1 } });
    expect(await record(7)).toEqual({ id: 7, name: 'Allowed', amount: 10, tenantId: 'B' });
  });

  it('does not publish or persist a create when an after-create hook fails', async () => {
    await grantMutation('create');
    app.db.on('documents.afterCreate', async () => {
      throw new Error('HTTP creation rollback fixture');
    });
    const response = await app
      .agent()
      .resource('documents')
      .create({ values: { name: 'Uncommitted' } });
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('data');
    expect(await app.db.getCollection('documents').model.count()).toBe(6);
  });
});
