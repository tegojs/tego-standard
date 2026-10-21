import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, type Collection, type Context } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootMutationHandler } from '../../access-control/root-mutation-handler';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
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
  let principal: { tenantId: string; roleName: string; userId: number };
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: `${collection.name}-key`,
  });

  beforeEach(async () => {
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
    const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
    const handler = new AccessRootReadHandler(db, adapter, queries, (collection) =>
      collection.name === 'documents' ? identity(collection) : undefined,
    );
    const writer = new AccessRootMutationHandler(db, adapter, queries, (collection) =>
      collection.name === 'documents' ? identity(collection) : undefined,
    );
    principal = { tenantId: 'B', roleName: 'member', userId: 28 };

    // These are server-authenticated fixture values, never request headers or action values.
    app.resourcer.use(
      async (ctx, next) => {
        const actor = { ...principal };
        ctx.state.currentRole = actor.roleName;
        ctx.state.currentTenant = { id: actor.tenantId };
        ctx.state.accessTestActor = actor;
        await adapter.prepare(ctx, [mainIdentity]);
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'access-test-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'access-test-acl', after: 'access-test-preparation' });
    app.resourcer.define({
      name: 'documents',
      actions: Object.fromEntries(
        ['list', 'get', 'count'].map((action) => [
          action,
          async (ctx: Context & { permission: unknown }) => {
            if (!('permission' in ctx)) throw new Error('ACL middleware did not finalize this request');
            await handler.handleResourceWithRelatedContexts(ctx, ctx.state.accessTestActor, async () => null);
          },
        ]),
      ),
    });
    for (const action of ['create', 'update', 'destroy'])
      app.resourcer.registerActionHandler(`documents:${action}`, async (resourceContext) => {
        const ctx = resourceContext as Context & { permission: unknown };
        if (!('permission' in ctx)) throw new Error('ACL middleware did not finalize this request');
        await writer.handle(ctx, ctx.state.accessTestActor);
      });
  });

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
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
