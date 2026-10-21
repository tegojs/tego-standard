import { pathToFileURL } from 'node:url';
import { mockServer, type MockServer } from '@tachybase/test';
import { ACL, type Collection, type Context } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { grantStoredScope, seedAclScopes } from './acl-database';
import { configStore, mainIdentity, seedConfigStore } from './config-database';
import { seedDatabase } from './database';
import { exampleConfig } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;

/** Isolated HTTP/ACL integration, not an authentication or production plugin activation fixture. */
describe.skipIf(!coreAvailable)('tenant access model over real HTTP reads', () => {
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
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer' },
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
});
