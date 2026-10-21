import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, RelationField, Resourcer, type Collection, type Context } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { seedDatabase } from './database';
import { configFor, exampleConfig } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;

/** Internal export rows over real HTTP/ACL; no production authentication or XLSX activation. */
describe.skipIf(!coreAvailable)('export rows over real HTTP resources', () => {
  let app: MockServer;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let unregister: (() => void) | undefined;
  let principal: { tenantId: string; roleName: string; userId: number };
  let beforeRelated: (() => Promise<void>) | undefined;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: `${collection.name}-key`,
  });
  const identities = () => ['documents', 'participants'].map((name) => identity(app.db.getCollection(name)));

  async function grant(resource: string, action: string, fields: string[], filter: object = {}) {
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: { key: 'custom', dataSourceKey: 'main', resourceName: resource, scope: filter },
    });
    const stored = await app.db.getRepository('dataSourcesRolesResourcesScopesActions').create({
      values: { name: action, fields, scopeId: scope.get('id') },
    });
    await stored.writeToACL({
      acl,
      role: acl.getRole('reader'),
      resourceName: resource,
      associationFieldsActions: {},
      grantHelper: {},
    });
  }

  beforeEach(async () => {
    beforeRelated = undefined;
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
    db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.getCollection('tenants').model.sync();
    await db.getCollection('tenants').model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    acl = new CoreACL();
    app.mainDataSource.acl = acl;
    acl.setAvailableAction('export', {});
    acl.setAvailableAction('list', {});
    acl.define({ role: 'reader' });
    acl.beforeGrantAction((ctx) => {
      const collection = db.getCollection(ctx.resourceName);
      const fields = ctx.params.fields as string[] | undefined;
      if (!collection || !fields) return;
      const appends = fields.filter((name) => collection.getField(name) instanceof RelationField);
      ctx.params = { ...ctx.params, fields: fields.filter((name) => !appends.includes(name)), appends };
    });
    await grant('documents', 'export', ['id', 'name', 'amount', 'participants']);
    await grant('documents', 'list', ['id'], { id: 3 });
    await grant('participants', 'list', ['id', 'businessTenant', 'canView']);
    store = new AccessConfigStore(db, (key) =>
      resolveModelMetadata(db.getCollection(key.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...exampleConfig, revision: 0 }, { userId: 28 });
    await db.getRepository('collections').create({ values: { key: 'participants-key', name: 'participants' } });
    await store.save(
      identity(db.getCollection('participants')),
      {
        ...configFor({
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'canView' },
          right: { type: 'literal', value: true },
        }),
        revision: 0,
        ownership: { enabled: false },
      },
      { userId: 28 },
    );
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
    const reader = new AccessRootReadHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
    principal = { tenantId: 'B', roleName: 'reader', userId: 28 };
    app.resourcer.use(
      async (ctx, next) => {
        ctx.state.currentRole = principal.roleName;
        ctx.state.currentTenant = { id: principal.tenantId };
        ctx.state.accessTestActor = { ...principal };
        await adapter.prepare(ctx, identities());
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'access-export-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'access-export-acl', after: 'access-export-preparation' });
    app.resourcer.define({
      name: 'documents',
      actions: Object.fromEntries(
        ['list', 'export'].map((action) => [
          action,
          async (resourceContext: Context & { permission: unknown }) => {
            const decisions: Array<Context & { permission: unknown }> = [];
            try {
              await reader.handleResourceWithRelatedContexts(
                resourceContext,
                resourceContext.state.accessTestActor,
                async (collection) => {
                  await beforeRelated?.();
                  const resourcer = new Resourcer();
                  resourcer.define({ name: collection.name, actions: { list: {} } });
                  const target = resourcer.getAction(collection.name, 'list').clone();
                  Object.assign(target, { resourceName: collection.name, actionName: 'list' });
                  target.mergeParams({ resourceName: collection.name, actionName: 'list', filterByTk: undefined });
                  const ctx = Object.assign(Object.create(resourceContext), { action: target, permission: undefined });
                  decisions.push(ctx);
                  await adapter.prepare(ctx, identities());
                  await acl.middleware()(ctx, async () => {});
                  return ctx;
                },
              );
            } finally {
              for (const decision of decisions) adapter.release(decision);
            }
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

  const runExport = (params: Record<string, unknown> = {}) =>
    app
      .agent()
      .resource('documents')
      .export({ fields: ['id'], sort: ['id'], ...params });

  it('exports all owned or visible roots once using export permission rather than list scope', async () => {
    const list = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'] });
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([{ id: 3 }]);
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ id: 1 }, { id: 3 }] });
    expect(response.body).not.toHaveProperty('meta');
  });

  it('does not require root list permission when export is independently allowed', async () => {
    acl.getRole('reader').revokeAction('documents:list');
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('retains the export role filter and request filter', async () => {
    await grant('documents', 'export', ['id', 'name', 'amount'], { amount: { $gte: 200 } });
    const response = await runExport({ filter: { id: { $in: [1, 3, 4] } } });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 3 }]);
  });

  it('scopes expanded targets independently without dropping readable roots', async () => {
    const response = await runExport({ fields: ['id', 'participants.id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { id: 1, participants: [{ id: 1 }, { id: 2 }] },
      { id: 3, participants: [] },
    ]);
  });

  it('exports all matching roots instead of silently stopping at the ordinary default page size', async () => {
    await app.db
      .getCollection('documents')
      .model.bulkCreate(
        Array.from({ length: 25 }, (_, index) => ({ id: 100 + index, tenantId: 'B', name: 'Owned', amount: 1 })),
      );
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(27);
    expect(response.body.data.at(-1)).toEqual({ id: 124 });
  });

  it('does not use root list permission to authorize export', async () => {
    acl.getRole('reader').revokeAction('documents:export');
    const response = await runExport();
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  });

  it('uses the trusted tenant and ignores a different client tenant header', async () => {
    principal = { ...principal, tenantId: 'C' };
    const response = await supertest(app.callback())
      .get('/api/documents:export')
      .set('x-tenant-id', 'B')
      .query({ fields: ['id'], sort: ['id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 4 }, { id: 6 }]);
  });

  it('rechecks rules on each independent export request', async () => {
    expect((await runExport()).body.data).toEqual([{ id: 1 }, { id: 3 }]);
    const config = (await store.read(mainIdentity))!;
    await store.save(mainIdentity, { ...config, rules: [] }, { userId: 28 });
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [] });
  });

  it('preserves requested sort and excluded fields', async () => {
    const response = await runExport({ fields: undefined, except: ['name'], sort: '-amount' });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { id: 3, amount: 300 },
      { id: 1, amount: 100 },
    ]);
  });

  it('rejects requested physical fields excluded by the export permission', async () => {
    await grant('documents', 'export', ['id']);
    const response = await runExport({ fields: ['id', 'amount'] });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it('does not use export permission to authorize an inaccessible related collection', async () => {
    acl.getRole('reader').revokeAction('participants:list');
    const response = await runExport({ fields: ['id', 'participants.id'] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    const unexpanded = await runExport();
    expect(unexpanded.status).toBe(200);
    expect(unexpanded.body.data).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('matches related filters against independently readable targets without duplicating roots', async () => {
    const response = await runExport({ filter: { participants: { businessTenant: 'B' } } });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 1 }]);
    principal = { ...principal, tenantId: 'H' };
    const hidden = await runExport({ filter: { participants: { canView: false } } });
    expect(hidden.status).toBe(200);
    expect(hidden.body.data).toEqual([]);
  });

  it('reads explicitly visible legacy data without claiming or changing it', async () => {
    const config = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      {
        ...config,
        rules: [
          ...config.rules,
          {
            ...configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }, 'visibility').rules[0],
            id: 'legacy-visible',
          },
        ],
      },
      { userId: 28 },
    );
    const response = await runExport({ filter: { id: 5 } });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 5 }]);
    expect((await app.db.getCollection('documents').model.findByPk(5))!.get('tenantId')).toBeNull();
  });

  it.each([{ fields: ['id'] }, { fields: ['id', 'participants.id'] }])(
    'returns exactly the complete-row bound but refuses a larger authorized result: %j',
    async ({ fields }) => {
      await app.db
        .getCollection('documents')
        .model.bulkCreate(
          Array.from({ length: 998 }, (_, index) => ({ id: 100 + index, tenantId: 'B', name: 'Owned', amount: 1 })),
        );
      const complete = await runExport({ fields });
      expect(complete.status).toBe(200);
      expect(complete.body.data).toHaveLength(1000);
      expect(complete.body.data.at(-1)).toEqual(fields.length === 1 ? { id: 1097 } : { id: 1097, participants: [] });
      await app.db.getCollection('documents').model.create({ id: 2000, tenantId: 'B', name: 'Overflow', amount: 1 });
      const overflow = await runExport({ fields });
      expect(overflow.status).toBe(400);
      expect(overflow.body).not.toHaveProperty('data');
    },
  );

  it('does not include inaccessible roots in the completeness bound', async () => {
    await app.db
      .getCollection('documents')
      .model.bulkCreate(
        Array.from({ length: 1001 }, (_, index) => ({ id: 100 + index, tenantId: 'C', name: 'Hidden', amount: 1 })),
      );
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it.each([{ fields: ['id'] }, { fields: ['id', 'participants.id'] }])(
    'rejects root-query overflow even when a returned row is deleted before a later count: %j',
    async ({ fields }) => {
      const model = app.db.getCollection('documents').model;
      await model.bulkCreate(
        Array.from({ length: 999 }, (_, index) => ({ id: 100 + index, tenantId: 'B', name: 'Owned', amount: 1 })),
      );
      const findAll = model.findAll;
      // Preserve the real query, inserting a real concurrent delete before the consumer resumes.
      const query = vi.spyOn(model, 'findAll').mockImplementationOnce(async function (options) {
        const rows = await findAll.call(this, options);
        await model.destroy({ where: { id: 1 } });
        return rows;
      });
      try {
        const response = await runExport({ fields });
        expect(await model.findByPk(1)).toBeNull();
        expect(response.status).toBe(400);
        expect(response.body).not.toHaveProperty('data');
      } finally {
        query.mockRestore();
      }
    },
  );

  it('does not publish data when relation metadata changes during target authorization', async () => {
    beforeRelated = async () => {
      Object.assign(app.db.getCollection('documents').model.associations.participants, { scope: { canView: false } });
    };
    const response = await runExport({ fields: ['id', 'participants.id'] });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it.each([
    { page: 2 },
    { pageSize: 1 },
    { paginate: false },
    { limit: 1 },
    { offset: 1 },
    { filterByTk: 1 },
    { where: { id: 1 } },
    { transaction: { id: 1 } },
    { columns: [{ dataIndex: ['id'] }] },
    { values: { tenantId: 'C' } },
    { permission: { skip: true } },
    { now: '2026-01-01' },
  ])('rejects unsupported export parameters without a partial response: %j', async (extra) => {
    const response = await runExport(extra);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });
});
