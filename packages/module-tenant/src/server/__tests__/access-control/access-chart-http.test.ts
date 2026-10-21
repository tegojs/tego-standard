import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, CacheManager, RelationField, Resourcer, type Collection, type Context } from '@tego/server';

import {
  createChartQuery,
  type ChartQueryResolver,
} from '../../../../../plugin-block-charts/src/server/actions/query-entry';
import DataVisualizationPlugin from '../../../../../plugin-block-charts/src/server/plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { AccessChartQueryHandler } from '../../access-control/chart-query-handler';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessReadDateContext } from '../../access-control/read-date-filter';
import type { AccessRootReadContext } from '../../access-control/root-read-context';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { seedDatabase } from './database';
import { configFor, exampleConfig, participantCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;
type ChartContext = Context & { permission: unknown };

/** Real HTTP/ACL with isolated SQLite data and server fixture identities, not real authentication. */
describe.skipIf(!coreAvailable)('chart statistics over real HTTP resources', () => {
  let app: MockServer;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let unregister: (() => void) | undefined;
  let principal: { tenantId: string; roleName: string; userId: number };
  let tenantScopeId: number;
  let beforeEntry: ((ctx: ChartContext) => void) | undefined;
  let beforeSource: ((ctx: ChartContext) => void | Promise<void>) | undefined;
  let identityKeys: Map<string, string>;
  let entryError: unknown;
  let dates: AccessReadDateContext | undefined;
  let legacyMode: boolean;
  let resolveEntry: ChartQueryResolver | undefined;
  let selectChartQuery: ChartQueryResolver;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: identityKeys.get(collection.name) ?? `${collection.name}-key`,
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
    beforeEntry = undefined;
    beforeSource = undefined;
    identityKeys = new Map();
    entryError = undefined;
    dates = undefined;
    legacyMode = false;
    resolveEntry = undefined;
    app = mockServer({
      acl: false,
      registerActions: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      resourcer: { prefix: '/api' },
    });
    const db = app.db;
    // This lightweight server has no plugin load phase; install the real memory cache explicitly.
    const cacheManager = new CacheManager();
    Object.defineProperty(app, 'cacheManager', { value: cacheManager });
    await cacheManager.createCache({ name: 'data-visualization', store: 'memory', ttl: 30000, max: 100 });
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
    const charts = new AccessChartQueryHandler(db, reader, identity);
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
    selectChartQuery = (ctx) =>
      resolveEntry
        ? resolveEntry(ctx)
        : legacyMode
          ? undefined
          : async (resourceContext) => {
              const ctx = resourceContext as Context & { permission: unknown };
              if (!ctx.action || !('permission' in ctx))
                throw new Error('ACL middleware did not finalize this request');
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
                beforeEntry?.(ctx);
                await charts.handle(
                  ctx,
                  ctx.state.accessTestActor,
                  {
                    source: async (collection) => {
                      const decision = await authorize(collection);
                      await beforeSource?.(ctx);
                      return decision;
                    },
                    related: authorize,
                  },
                  undefined,
                  dates,
                );
              } catch (error) {
                entryError = error;
                throw error;
              } finally {
                for (const decision of decisions) adapter.release(decision);
              }
            };
    app.resourcer.define({
      name: 'charts',
      actions: { query: createChartQuery(selectChartQuery) },
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

  async function warmLegacyCache() {
    await grant('documents', ['id', 'name', 'amount', 'tenantId', 'participants'], {});
    const input = { ...values(), cache: { enabled: true, ttl: 60 }, refresh: false };
    legacyMode = true;
    const warmed = await query(input);
    expect(warmed.status).toBe(200);
    expect(warmed.body).toEqual({ data: [{ 金额: 2100 }] });
    await app.db.getCollection('documents').model.update({ amount: 333 }, { where: { id: 3 } });
    // A second old-path request must really use the cache, rather than just repeat the query.
    const cached = await query(input);
    expect(cached.status).toBe(200);
    expect(cached.body).toEqual({ data: [{ 金额: 2100 }] });
    legacyMode = false;
    return input;
  }

  function registerChartPlugin(options: { queryResolver?: ChartQueryResolver } = {}) {
    const plugin = new DataVisualizationPlugin(app, { name: 'data-visualization', ...options });
    plugin.beforeLoad();
    return plugin;
  }

  describe('plugin registered chart entry', () => {
    it('selects the scoped executor before the real legacy cache', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: selectChartQuery });
      const response = await query(input);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [{ 金额: 433 }] });
    });

    it('preserves the original cache, refresh and disabled-cache behavior without a resolver', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin();
      const cached = await query(input);
      expect(cached.status).toBe(200);
      expect(cached.body).toEqual({ data: [{ 金额: 2100 }] });
      const refreshed = await query({ ...input, refresh: true });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body).toEqual({ data: [{ 金额: 2133 }] });
      await app.db.getCollection('documents').model.update({ amount: 444 }, { where: { id: 3 } });
      const uncached = await query({ ...input, cache: { enabled: false } });
      expect(uncached.status).toBe(200);
      expect(uncached.body).toEqual({ data: [{ 金额: 2244 }] });
      const retained = await query(input);
      expect(retained.status).toBe(200);
      expect(retained.body).toEqual({ data: [{ 金额: 2133 }] });
    });

    it('preserves the old route when a configured resolver explicitly declines the request', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: () => undefined });
      const response = await query(input);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [{ 金额: 2100 }] });
    });

    it('keeps the registered resolver when the startup options are later replaced', async () => {
      const input = await warmLegacyCache();
      const plugin = registerChartPlugin({ queryResolver: selectChartQuery });
      plugin.options.queryResolver = () => undefined;
      const response = await query(input);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [{ 金额: 433 }] });
    });

    it('does not activate a late resolver on an originally unconfigured plugin', async () => {
      const input = await warmLegacyCache();
      const plugin = registerChartPlugin();
      plugin.options.queryResolver = selectChartQuery;
      const response = await query(input);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [{ 金额: 2100 }] });
    });

    it('retains the plugin logged-in grant while independently restricting source records', async () => {
      registerChartPlugin({ queryResolver: selectChartQuery });
      acl.getRole('editor').revokeAction('charts:query');
      const response = await query();
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [{ 金额: 400 }] });
    });

    it('does not treat the logged-in chart grant as source collection authorization', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: selectChartQuery });
      acl.getRole('editor').revokeAction('documents:view');
      const response = await query(input);
      expect(response.status).toBe(403);
      expect(response.body).not.toHaveProperty('data');
    });

    it('keeps the source role scope after the logged-in chart grant', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: selectChartQuery });
      await grant('documents', ['id', 'name', 'amount', 'tenantId', 'participants'], { id: 1 });
      const response = await query(input);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [{ 金额: 100 }] });
    });

    it('rechecks measure field authorization instead of publishing warmed cache data', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: selectChartQuery });
      await grant('documents', ['id', 'name'], {});
      const response = await query(input);
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
    });

    it('checks related collection access independently and preserves internal authorization facts', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: selectChartQuery });
      acl.getRole('editor').revokeAction('participants:view');
      const filtered = await query({ ...input, filter: { participants: { businessTenant: 'B' } } });
      expect(filtered.status).toBe(403);
      expect(filtered.body).not.toHaveProperty('data');
      const unfiltered = await query(input);
      expect(unfiltered.status).toBe(200);
      expect(unfiltered.body).toEqual({ data: [{ 金额: 433 }] });
    });

    it('rechecks current rules after plugin registration', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: selectChartQuery });
      const config = (await store.read(mainIdentity))!;
      await store.save(mainIdentity, { ...config, rules: [] }, { userId: 28 });
      const response = await query(input);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [{ 金额: null }] });
    });

    it('uses the server tenant rather than client headers and cached chart identity', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: selectChartQuery });
      principal = { ...principal, tenantId: 'C' };
      const response = await query(input).set('x-tenant-id', 'B');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [{ 金额: 1000 }] });
    });

    it('does not fall back to the cache when the registered selector fails', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: selectChartQuery });
      resolveEntry = () => {
        throw new Error('Registered chart selection failed');
      };
      const response = await query(input);
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('data');
    });

    it('does not fall back after the registered executor fails', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: selectChartQuery });
      const failure = new Error('Registered collection authorization failed');
      beforeSource = () => {
        throw failure;
      };
      const response = await query(input);
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('data');
      expect(entryError).toBe(failure);
    });

    it('handles an accidentally asynchronous registered selection without an unhandled rejection', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({
        queryResolver: (async () => {
          throw new Error('Async registered selection failed');
        }) as unknown as ChartQueryResolver,
      });
      const response = await query(input);
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('data');
    });

    it('does not fall back when the registered executor returns no response', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: () => async () => {} });
      const response = await query(input);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    it('does not accept client values as plugin startup configuration', async () => {
      const input = await warmLegacyCache();
      registerChartPlugin({ queryResolver: selectChartQuery });
      const response = await query({ ...input, queryResolver: null });
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
    });

    it.each([null, false, 'query', {}])(
      'rejects invalid startup selection before replacing the route: %s',
      async (selection) => {
        const input = await warmLegacyCache();
        expect(() => registerChartPlugin({ queryResolver: selection as unknown as ChartQueryResolver })).toThrow(
          TypeError,
        );
        const response = await query(input);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ data: [{ 金额: 433 }] });
      },
    );
  });

  it('bypasses a warmed real legacy cache without replacing or invalidating its entries', async () => {
    const input = await warmLegacyCache();
    const scoped = await query(input);
    expect(scoped.status).toBe(200);
    expect(scoped.body).toEqual({ data: [{ 金额: 433 }] });
    legacyMode = true;
    const cached = await query(input);
    expect(cached.status).toBe(200);
    expect(cached.body).toEqual({ data: [{ 金额: 2100 }] });
  });

  it('preserves refresh and uncached behavior for requests explicitly left on the old path', async () => {
    const input = await warmLegacyCache();
    legacyMode = true;
    const refreshed = await query({ ...input, refresh: true });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toEqual({ data: [{ 金额: 2133 }] });
    await app.db.getCollection('documents').model.update({ amount: 444 }, { where: { id: 3 } });
    const cached = await query(input);
    expect(cached.status).toBe(200);
    expect(cached.body).toEqual({ data: [{ 金额: 2133 }] });
    const uncached = await query({ ...input, cache: { enabled: false, ttl: 60 } });
    expect(uncached.status).toBe(200);
    expect(uncached.body).toEqual({ data: [{ 金额: 2244 }] });
  });

  it.each([null, false, Promise.resolve(undefined)])(
    'rejects invalid server selection without using cached data: %s',
    async (selection) => {
      const input = await warmLegacyCache();
      resolveEntry = (() => selection) as unknown as ChartQueryResolver;
      const response = await query(input);
      expect(response.status).toBe(500);
      expect(response.body).not.toHaveProperty('data');
    },
  );

  it('does not use cached data after server query selection fails', async () => {
    const input = await warmLegacyCache();
    resolveEntry = () => {
      throw new Error('Server query selection failed');
    };
    const response = await query(input);
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('data');
  });

  it('handles a rejected asynchronous selection without an unhandled rejection or cached response', async () => {
    const input = await warmLegacyCache();
    resolveEntry = (async () => {
      throw new Error('Asynchronous query selection failed');
    }) as unknown as ChartQueryResolver;
    const response = await query(input);
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('data');
  });

  it('rejects an asynchronously selected executor without running it', async () => {
    const input = await warmLegacyCache();
    let executed = false;
    resolveEntry = (async () => async () => {
      executed = true;
    }) as unknown as ChartQueryResolver;
    const response = await query(input);
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('data');
    expect(executed).toBe(false);
  });

  it('does not fall through when a selected executor publishes no body', async () => {
    const input = await warmLegacyCache();
    resolveEntry = () => async () => {};
    const response = await query(input);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  it('rechecks rule changes even when an old-path cache entry exists', async () => {
    const input = await warmLegacyCache();
    const config = (await store.read(mainIdentity))!;
    await store.save(mainIdentity, { ...config, rules: [] }, { userId: 28 });
    const response = await query(input);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: null }] });
  });

  it('rechecks field grants instead of exposing an old cached measure', async () => {
    const input = await warmLegacyCache();
    await grant('documents', ['id', 'name'], {});
    const response = await query(input);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it('does not fall back to a warm legacy cache when the selected executor throws', async () => {
    const input = await warmLegacyCache();
    const failure = new Error('Independent source authorization failed');
    beforeSource = () => {
      throw failure;
    };
    const response = await query(input);
    expect(response.status).toBe(500);
    expect(response.body).not.toHaveProperty('data');
    expect(entryError).toBe(failure);
  });

  it('keeps server tenant selection independent of warmed cache metadata and client routing hints', async () => {
    const input = await warmLegacyCache();
    principal = { ...principal, tenantId: 'C' };
    const response = await query(input).set('x-tenant-id', 'B');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: 1000 }] });
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

  it('returns the first requested groups after ordering the complete readable root set', async () => {
    const response = await query({
      ...values(),
      dimensions: [{ field: 'tenantId', alias: '归属' }],
      orders: [{ field: 'amount', alias: '金额', order: 'desc' }],
      limit: 1,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 归属: 'B', 金额: 300 }] });
  });

  it('limits grouped multiple measures without limiting the records used in each group', async () => {
    await app.db.getCollection('documents').model.create({ id: 10, tenantId: 'B', amount: 50 });
    const response = await query({
      ...values(),
      measures: [
        { field: 'amount', aggregation: 'sum', alias: '金额' },
        { field: 'id', aggregation: 'count', alias: '数量' },
      ],
      dimensions: [{ field: 'tenantId', alias: '归属' }],
      orders: [{ alias: '金额', order: 'desc' }],
      limit: 1,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 归属: 'B', 金额: 350, 数量: 2 }] });
  });

  it('does not limit the source records of a scalar chart', async () => {
    const response = await query({ ...values(), limit: 1 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: 400 }] });
  });

  it('captures display count before awaiting independent collection authorization', async () => {
    beforeSource = (ctx) => {
      const permission = ctx.permission as { rawParams: { values: { limit: number } } };
      permission.rawParams.values.limit = 2;
    };
    const response = await query({
      ...values(),
      dimensions: [{ field: 'tenantId', alias: '归属' }],
      orders: [{ alias: '金额', order: 'desc' }],
      limit: 1,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 归属: 'B', 金额: 300 }] });
  });

  it.each([undefined, null, 0, 2000])('uses the existing 2000 group display limit: %s', async (limit) => {
    await app.db
      .getCollection('documents')
      .model.bulkCreate(Array.from({ length: 2001 }, (_, index) => ({ id: 100 + index, tenantId: 'B', amount: 1 })));
    const response = await query({
      ...values(),
      dimensions: [{ field: 'id', alias: '编号' }],
      orders: [{ field: 'id', alias: '编号', order: 'asc' }],
      ...(limit === undefined ? {} : { limit }),
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2000);
    expect(response.body.data[0]).toEqual({ 编号: 1, 金额: 100 });
    expect(response.body.data[1]).toEqual({ 编号: 3, 金额: 300 });
    expect(response.body.data[1999]).toEqual({ 编号: 2097, 金额: 1 });
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

  it.each([{ filter: { amount: { $gte: 200 } } }, { own: true }, { fields: ['amount'] }, { limit: 1 }])(
    'rejects chart operation constraints that cannot be transferred to collection reads: %j',
    async (params) => {
      acl.addFixedParams('charts', 'query', () => params);
      const response = await query();
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(entryError).toMatchObject({ message: 'Unsupported chart operation permission constraints' });
    },
  );

  it.each(['resourceName', 'actionName', 'role'] as const)(
    'rejects a mismatched finalized chart permission %s',
    async (key) => {
      beforeEntry = (ctx) => {
        const permission = ctx.permission as { resourceName: string; actionName: string; can: { role: string } };
        if (key === 'role') permission.can.role = 'other-role';
        else permission[key] = 'other-operation';
      };
      const response = await query();
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(entryError).toMatchObject({ message: expect.stringMatching(/permission.*(?:operation|binding)/) });
    },
  );

  it('rejects a non-chart resource descriptor despite a valid chart decision', async () => {
    beforeEntry = (ctx) => {
      ctx.action.resourceName = 'documents';
    };
    const response = await query();
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(entryError).toMatchObject({ message: 'Chart entry requires an authenticated charts:query operation' });
  });

  it('rejects extra resource query conditions instead of silently dropping them', async () => {
    const response = await query().query({ filter: JSON.stringify({ id: 4 }) });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(entryError).toMatchObject({ message: 'Unsupported chart entry parameters' });
  });

  it('captures the original chart input and actor before awaiting source authorization', async () => {
    beforeSource = async (ctx) => {
      await Promise.resolve();
      const permission = ctx.permission as { rawParams: { values: { filter: object; collection: string } } };
      permission.rawParams.values.filter = { id: 4 };
      permission.rawParams.values.collection = 'participants';
      ctx.state.accessTestActor.tenantId = 'C';
      ctx.state.accessTestActor.roleName = 'other-role';
    };
    const response = await query();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: 400 }] });
  });

  it('rejects replacement of the persistent collection identity during source authorization', async () => {
    beforeSource = () => {
      identityKeys.set('documents', 'replacement-document-key');
    };
    const response = await query();
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
    expect(entryError).toMatchObject({ message: 'Chart collection identity changed during authorization' });
  });

  it('captures the date context before awaiting source authorization', async () => {
    const suppliedDates = { now: '2026-10-21T12:00:00.000Z', timezone: '+08:00' };
    dates = suppliedDates;
    beforeSource = () => {
      suppliedDates.now = 'invalid';
      suppliedDates.timezone = 'invalid';
    };
    const response = await query();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ 金额: 400 }] });
  });

  it('does not publish an aggregate if collection identity changes after its SQL executes', async () => {
    let executedAggregate = false;
    const sequelize = app.db.sequelize;
    sequelize.addHook('afterQuery', 'replace-chart-identity', (_options, sqlQuery) => {
      const sql = String((sqlQuery as { sql?: string }).sql ?? '');
      if (/\bsum\s*\(/i.test(sql) && sql.includes('access_documents')) {
        executedAggregate = true;
        identityKeys.set('documents', 'replacement-document-key');
      }
    });
    try {
      const response = await query();
      expect(executedAggregate).toBe(true);
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('data');
      expect(entryError).toBeInstanceOf(Error);
    } finally {
      sequelize.removeHook('afterQuery', 'replace-chart-identity');
    }
  });

  it.each([
    { dataSource: 'external' },
    { collection: 'roles' },
    { sql: { fields: '*' } },
    { measures: [{ field: ['participants', 'id'], aggregation: 'count', alias: '数量' }] },
    { measures: [{ field: ['amount'], aggregation: 'median', alias: '金额' }] },
    { limit: -1 },
    { limit: 1.5 },
    { limit: '1' },
    { limit: 2001 },
    { take: 1 },
  ])('rejects unsupported chart input without publishing data: %j', async (extra) => {
    const response = await query({ ...values(), ...extra });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });
});
