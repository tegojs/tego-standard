import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, RelationField, Resourcer, type Collection, type Context } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { parseChartQueryParams } from '../../access-control/chart-query-params';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessRootReadContext } from '../../access-control/root-read-context';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { invalid } from '../../access-control/write-support';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { seedDatabase } from './database';
import { configFor, exampleConfig, participantCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;

/** Real HTTP/ACL with isolated SQLite data and server fixture identities, not real authentication. */
describe.skipIf(!coreAvailable)('chart statistics over real HTTP resources', () => {
  let app: MockServer;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let unregister: (() => void) | undefined;
  let principal: { tenantId: string; roleName: string; userId: number };
  let tenantScopeId: number;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: `${collection.name}-key`,
  });
  const identities = () => ['documents', 'participants'].map((name) => identity(app.db.getCollection(name)));
  const values = () => ({
    uid: 'summary-card',
    dataSource: 'main',
    collection: 'documents',
    measures: [{ field: ['amount'], aggregation: 'sum', alias: '金额' }],
    dimensions: [] as object[],
    filter: {},
    orders: [] as object[],
  });
  const query = (input: object = values()) => supertest(app.callback()).post('/api/charts:query').send(input);

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
        { name: 'amount', type: 'integer' },
        { name: 'name', type: 'string' },
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
    await db.getRepository('collections').create({ values: { key: 'participants-key', name: 'participants' } });
    store = new AccessConfigStore(db, (key) =>
      resolveModelMetadata(db.getCollection(key.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...exampleConfig, revision: 0 }, { userId: 28 });
    await store.save(
      identity(db.getCollection('participants')),
      {
        ...configFor(participantCondition.condition, 'visibility'),
        ownership: { enabled: false },
        revision: 0,
      },
      { userId: 28 },
    );
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    acl = new CoreACL();
    app.mainDataSource.acl = acl;
    acl.define({ role: 'editor' });
    acl.setAvailableAction('view', { aliases: ['get', 'list', 'count'] });
    acl.setAvailableAction('query', {});
    acl.beforeGrantAction((ctx) => {
      const collection = db.getCollection(ctx.resourceName);
      const fields = ctx.params.fields as string[] | undefined;
      if (!collection || !fields || acl.resolveActionAlias(ctx.actionName) !== 'view') return;
      const appends = fields.filter((name) => collection.getField(name) instanceof RelationField);
      ctx.params = { ...ctx.params, fields: fields.filter((name) => !appends.includes(name)), appends };
    });
    tenantScopeId = (
      await db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: { key: 'tenant', dataSourceKey: 'main', scope: { tenantId: '{{ ctx.state.currentTenant.id }}' } },
      })
    ).get('id');
    await grant('documents', ['id', 'name', 'amount', 'tenantId', 'participants']);
    await grant('participants', ['id', 'documentId', 'businessTenant', 'canView']);
    await grant('charts', [], {}, 'query');
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
    principal = { tenantId: 'B', roleName: 'editor', userId: 28 };
    app.resourcer.use(
      async (ctx, next) => {
        ctx.state.currentRole = principal.roleName;
        ctx.state.currentTenant = { id: principal.tenantId };
        ctx.state.currentUser = { id: principal.userId };
        ctx.state.accessTestActor = { ...principal };
        await adapter.prepare(ctx, identities());
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'chart-access-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'chart-access-acl', after: 'chart-access-preparation' });
    const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
    const reader = new AccessRootReadHandler(db, adapter, queries, identity);
    app.resourcer.define({
      name: 'documents',
      actions: {
        list: (resourceContext) => {
          const ctx = resourceContext as Context & { permission: unknown };
          if (!('permission' in ctx)) throw new Error('ACL middleware did not finalize this request');
          return reader.handleResourceWithRelatedContexts(ctx, ctx.state.accessTestActor, async () => null);
        },
      },
    });
    app.resourcer.define({
      name: 'charts',
      actions: {
        query: async (resourceContext) => {
          const ctx = resourceContext as Context & { permission: unknown };
          if (!ctx.action || !('permission' in ctx)) throw new Error('ACL middleware did not finalize this request');
          // Capture validated HTTP values before independently authorizing the selected collection.
          const parsed = parseChartQueryParams(ctx.action.params.values);
          const input = structuredClone(ctx.action.params.values);
          const collection = db.collections.get(parsed.collection);
          if (!collection || !identities().some((key) => key.collectionName === collection.name))
            invalid('Chart collection is unavailable');
          const decisions: AccessRootReadContext[] = [];
          const authorize = async (target: Collection) => {
            const resourcer = new Resourcer();
            resourcer.define({ name: target.name, actions: { list: {} } });
            const action = resourcer.getAction(target.name, 'list').clone();
            Object.assign(action, { resourceName: target.name, actionName: 'list' });
            action.mergeParams({ resourceName: target.name, actionName: 'list', filterByTk: undefined });
            const decision = {
              db,
              action,
              permission: undefined as unknown,
              state: ctx.state,
              get: ctx.get.bind(ctx),
              logger: ctx.logger,
              throw: ctx.throw.bind(ctx),
              body: undefined as unknown,
            };
            decisions.push(decision);
            await adapter.prepare(decision, identities());
            await acl.middleware()(decision as never, async () => {});
            return decision;
          };
          try {
            const source = await authorize(collection);
            await reader.handleChartWithRelatedContexts(source, ctx.state.accessTestActor, input, authorize);
            ctx.body = source.body;
          } finally {
            for (const decision of decisions) adapter.release(decision);
          }
        },
      },
    });
  });

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  async function grant(resourceName: string, fields: string[], filter?: object, name = 'view') {
    const db = app.db;
    const scopeId =
      filter === undefined
        ? tenantScopeId
        : (
            await db.getRepository('dataSourcesRolesResourcesScopes').create({
              values: { key: `custom-${resourceName}-${name}`, dataSourceKey: 'main', scope: filter },
            })
          ).get('id');
    const action = await db.getRepository('dataSourcesRolesResourcesScopesActions').create({
      values: { name, fields, scopeId },
    });
    await action.writeToACL({
      acl,
      role: acl.getRole('editor'),
      resourceName,
      associationFieldsActions: {},
      grantHelper: {},
    });
  }

  it('sums only owned and visible records without multiplying shared participants', async () => {
    const response = await query();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: 400 }] });
  });

  it('counts the same readable roots as the resource list', async () => {
    const list = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'], sort: ['id'] });
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([{ id: 1 }, { id: 3 }]);
    expect(list.body.meta.count).toBe(2);
    const response = await query({
      ...values(),
      measures: [{ field: ['id'], aggregation: 'count', alias: '数量' }],
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 数量: 2 }] });
  });

  it('computes multiple measures from one readable root set', async () => {
    const response = await query({
      ...values(),
      measures: [
        { field: ['amount'], aggregation: 'sum', alias: 'sum' },
        { field: ['amount'], aggregation: 'avg', alias: 'avg' },
        { field: ['amount'], aggregation: 'min', alias: 'min' },
        { field: ['amount'], aggregation: 'max', alias: 'max' },
        { field: ['id'], aggregation: 'count', alias: 'count' },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ sum: 400, avg: 200, min: 100, max: 300, count: 2 }] });
  });

  it('groups and orders only readable records', async () => {
    const response = await query({
      ...values(),
      dimensions: [{ field: ['tenantId'], alias: '归属' }],
      orders: [{ field: 'amount', alias: '金额', order: 'desc' }],
      limit: 2,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [
        { 归属: 'B', 金额: 300 },
        { 归属: 'H', 金额: 100 },
      ],
    });
  });

  it('rejects groups beyond the completeness bound instead of publishing partial statistics', async () => {
    const response = await query({
      ...values(),
      dimensions: [{ field: 'tenantId', alias: '归属' }],
      limit: 1,
    });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it('intersects request filters with ownership and visibility', async () => {
    const visible = await query({ ...values(), filter: { id: 1 } });
    expect(visible.status).toBe(200);
    expect(visible.body).toEqual({ data: [{ 金额: 100 }] });
    const hidden = await query({ ...values(), filter: { id: 4 } });
    expect(hidden.status).toBe(200);
    expect(hidden.body).toEqual({ data: [{ 金额: null }] });
  });

  it('preserves an empty grouped result', async () => {
    const response = await query({
      ...values(),
      filter: { id: 4 },
      dimensions: [{ field: 'tenantId', alias: '归属' }],
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [] });
  });

  it('retains the collection role filter independently of model visibility', async () => {
    await grant('documents', ['id', 'name', 'amount', 'tenantId', 'participants'], { amount: { $gte: 200 } });
    const response = await query();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: 300 }] });
  });

  it('retains fixed collection conditions on the independent list decision', async () => {
    acl.addFixedParams('documents', 'list', () => ({ filter: { id: 1 } }));
    const response = await query();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: 100 }] });
  });

  it('does not substitute chart permission for the collection read operation', async () => {
    acl.getRole('editor').revokeAction('documents:view');
    const response = await query();
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  });

  it('requires the chart resource operation in addition to collection access', async () => {
    acl.getRole('editor').revokeAction('charts:query');
    const response = await query();
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  });

  it.each([
    { fields: ['id', 'name', 'tenantId'], extra: {} },
    { fields: ['id', 'name', 'amount'], extra: { dimensions: [{ field: 'tenantId', alias: '归属' }] } },
    { fields: ['id', 'amount', 'tenantId'], extra: { filter: { name: 'D1' } } },
  ])('requires collection field permission for measures, groups and filters: $fields', async ({ fields, extra }) => {
    await grant('documents', fields);
    const response = await query({ ...values(), ...extra });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it('filters by readable participants without multiplying the matching root', async () => {
    const response = await query({
      ...values(),
      measures: [
        { field: ['amount'], aggregation: 'sum', alias: '金额' },
        { field: ['id'], aggregation: 'count', alias: '数量' },
      ],
      filter: { participants: { businessTenant: 'B' } },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: 100, 数量: 1 }] });
  });

  it('retains the related collection role scope during chart filtering', async () => {
    await grant('participants', ['id', 'documentId', 'businessTenant', 'canView'], { id: 3 });
    const response = await query({ ...values(), filter: { participants: { businessTenant: 'B' } } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: null }] });
  });

  it('uses related visibility for request filters while keeping rule facts internal', async () => {
    const target = identity(app.db.getCollection('participants'));
    const config = (await store.read(target))!;
    await store.save(target, { ...config, rules: [] }, { userId: 28 });
    const filtered = await query({ ...values(), filter: { participants: { businessTenant: 'B' } } });
    expect(filtered.status).toBe(200);
    expect(filtered.body).toEqual({ data: [{ 金额: null }] });
    const unfiltered = await query();
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body).toEqual({ data: [{ 金额: 400 }] });
  });

  it('requires independent target read permission when the request filters by that target', async () => {
    acl.getRole('editor').revokeAction('participants:view');
    const response = await query({ ...values(), filter: { participants: { businessTenant: 'B' } } });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    const unfiltered = await query();
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body).toEqual({ data: [{ 金额: 400 }] });
  });

  it('requires source association field permission for related chart filters', async () => {
    await grant('documents', ['id', 'amount']);
    const response = await query({ ...values(), filter: { participants: { businessTenant: 'B' } } });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it('requires target field permission for related chart filters', async () => {
    await grant('participants', ['id']);
    const response = await query({ ...values(), filter: { participants: { businessTenant: 'B' } } });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it('uses the current server tenant for repeated requests with the same cache metadata', async () => {
    const input = { ...values(), cache: { enabled: true, ttl: 3600 }, refresh: false };
    const b = await query(input);
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ data: [{ 金额: 400 }] });
    principal = { ...principal, tenantId: 'C', userId: 29 };
    const c = await query(input);
    expect(c.status).toBe(200);
    expect(c.body).toEqual({ data: [{ 金额: 1000 }] });
    principal = { ...principal, tenantId: 'B', userId: 28 };
    const bAgain = await query(input);
    expect(bAgain.status).toBe(200);
    expect(bAgain.body).toEqual({ data: [{ 金额: 400 }] });
  });

  it('rechecks collection permission even when a chart uid and cache options are reused', async () => {
    const input = { ...values(), cache: { enabled: true, ttl: 3600 } };
    const initial = await query(input);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ data: [{ 金额: 400 }] });
    acl.getRole('editor').revokeAction('documents:view');
    const denied = await query(input);
    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('data');
  });

  it('uses a committed rule change on the next request instead of a previous chart result', async () => {
    const input = { ...values(), cache: { enabled: true, ttl: 3600 } };
    const before = await query(input);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ data: [{ 金额: 400 }] });
    const config = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      { ...config, rules: config.rules.filter((rule) => rule.category === 'ownership') },
      { userId: 28 },
    );
    const after = await query(input);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ data: [{ 金额: 300 }] });
  });

  it('does not take the trusted actor from client headers', async () => {
    const response = await query().set('x-tenant-id', 'C').set('x-role', 'root');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: 400 }] });
  });

  it.each([
    { dataSource: 'external' },
    { collection: 'roles' },
    { sql: { fields: '*' } },
    { measures: [{ field: ['participants', 'id'], aggregation: 'count', alias: '数量' }] },
    { measures: [{ field: ['amount'], aggregation: 'median', alias: '金额' }] },
  ])('rejects unsupported chart input without publishing data: %j', async (extra) => {
    const response = await query({ ...values(), ...extra });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });
});
