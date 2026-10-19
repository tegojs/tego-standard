import {
  ACL,
  DataTypes,
  Field,
  FilterParser,
  literal,
  Op,
  Resourcer,
  type Collection,
  type Database,
  type Model,
} from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { captureFinalReadPermission } from '../../access-control/final-read-permission';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessReadGrantAdapter, type AccessEntryReadPermission } from '../../access-control/read-grants';
import { collectRelatedReadPaths } from '../../access-control/read-paths';
import { AccessReadService } from '../../access-control/reads';
import { prepareRelatedReadContexts } from '../../access-control/related-read-contexts';
import type { AccessFilterReadGrant } from '../../access-control/request-filter';
import { AccessRootReadHandler, type AccessRelatedReadContextResolver } from '../../access-control/root-read-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };
const identities = [mainIdentity, projectIdentity];
class CalendarDateField extends Field {
  get dataType() {
    return DataTypes.DATEONLY;
  }
}

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('unified root reads (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let reads: AccessReadService;
  let grants: Map<string, AccessFilterReadGrant | null>;
  let resolver: ReturnType<typeof vi.fn>;
  let entryReads: AccessEntryReadService;
  let permissions: Map<string, AccessEntryReadPermission | null>;
  let entryResolver: ReturnType<typeof vi.fn>;
  let ctx: object;
  const auth = { tenantId: 'B' };
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    db.registerFieldTypes({ calendarDate: CalendarDateField });
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const identity of identities) {
      const collection = db.collection({
        name: identity.collectionName,
        tableName: `read_${identity.collectionName}`,
        timestamps: true,
        paranoid: true,
        defaultScope: { where: { enabled: true } },
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string', field: 'display_name' },
          { name: 'amount', type: 'integer' },
          { name: 'enabled', type: 'boolean', defaultValue: true },
          { name: 'projectId', type: 'integer', field: 'project_id' },
          { name: 'deletedAt', type: 'date' },
          { name: 'labels', type: 'json' },
          { name: 'occurredAt', type: 'date', field: 'occurred_at' },
          { name: 'calendarDate', type: 'calendarDate', field: 'calendar_date' },
        ],
      });
      await collection.model.sync();
      if (identity !== mainIdentity)
        await db
          .getRepository('collections')
          .create({ values: { key: identity.collectionKey, name: collection.name } });
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Owned', amount: 10, projectId: 101 },
      { id: 2, tenantId: 'H', name: 'Visible', amount: 20, projectId: 102 },
      { id: 3, tenantId: 'C', name: 'Hidden', amount: 30, projectId: 101 },
      { id: 4, tenantId: null, name: 'Legacy', amount: 40, projectId: 103 },
      { id: 5, tenantId: 'B', name: 'Empty', amount: 50 },
      { id: 6, tenantId: 'B', name: 'Disabled', amount: 60, enabled: false },
      { id: 7, tenantId: 'B', name: 'Deleted', amount: 70, deletedAt: new Date() },
    ]);
    await projects.model.bulkCreate([
      { id: 101, tenantId: 'B', name: 'Zebra' },
      { id: 102, tenantId: 'C', name: 'Secret' },
      { id: 103, tenantId: 'B', name: 'Alpha' },
    ]);
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    const key = (collection: Collection) =>
      accessCollectionKey(identities.find((i) => i.collectionName === collection.name)!);
    const store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: key }),
    );
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor(
        {
          type: 'compare',
          operator: 'in',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: ['Visible', 'Legacy'] },
        },
        'visibility',
      ).rules[0],
      id: 'visible',
    });
    for (const identity of identities) await store.save(identity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    ctx = {};
    await adapter.prepare(ctx, identities);
    queries = new AccessQueryService(db, adapter, key);
    grants = new Map();
    resolver = vi.fn((collection: Collection, path: readonly string[]) =>
      grants.has(path.join('.'))
        ? grants.get(path.join('.'))
        : {
            identity: identities.find((i) => i.collectionName === collection.name)!,
            fields: [...Object.keys(collection.model.rawAttributes), ...Object.keys(collection.model.associations)],
          },
    );
    reads = new AccessReadService(db, adapter, queries, resolver);
    permissions = new Map();
    entryResolver = vi.fn((_collection: Collection, path: readonly string[]) =>
      permissions.has(path.join('.')) ? permissions.get(path.join('.'))! : { allowed: true, params: {} },
    );
    entryReads = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => identities.find((identity) => identity.collectionName === collection.name),
      entryResolver,
    );
  });
  describe('root handler', () => {
    const createHandler = (
      resolveIdentity = (collection: Collection) =>
        identities.find((identity) => identity.collectionName === collection.name),
      related?: AccessRelatedReadContextResolver,
    ) => new AccessRootReadHandler(db, adapter, queries, resolveIdentity, related);
    const allowed = () => {
      const acl = new ACL();
      acl.setAvailableAction('view', { aliases: ['list', 'get'] });
      acl.setAvailableAction('count', {});
      acl.define({ role: 'reader' }).grantAction('documents:view', {});
      acl.getRole('reader').grantAction('documents:count', {});
      return acl;
    };
    const context = (actionName = 'list', params: Record<string, unknown> = {}, resourceName = 'documents') => {
      const resourcer = new Resourcer();
      resourcer.define({ name: resourceName, actions: { list: {}, get: {}, count: {} } });
      const action = resourcer.getAction(resourceName, actionName).clone();
      Object.assign(action, { resourceName, actionName, sourceId: undefined, resourceOf: undefined });
      action.params.filterByTk = undefined;
      action.mergeParams({ resourceName, actionName, ...params });
      return Object.assign(ctx, {
        db,
        action,
        state: { currentRole: 'reader', currentUser: { id: 28, projectName: 'Secret' } },
        get: () => '+08:00',
        logger: { info: vi.fn() },
        throw: (status: number) => {
          throw new Error(String(status));
        },
        permission: undefined as unknown,
        body: 'unchanged' as unknown,
        paginate: false,
      });
    };
    const trusted = () => ({ tenantId: 'B', userId: 28, roleName: 'reader' });
    const authorized = async (
      actionName = 'list',
      params: Record<string, unknown> = {},
      acl = allowed(),
      resourceName = 'documents',
    ) => {
      const result = context(actionName, params, resourceName);
      await acl.middleware()(result as never, async () => {});
      return result;
    };

    describe('path planning', () => {
      const plan = (
        params: unknown,
        kind: 'list' | 'get' | 'count' = 'list',
        dates?: { now: string; timezone: string },
      ) =>
        collectRelatedReadPaths(
          db,
          adapter,
          queries,
          (collection) => identities.find((identity) => identity.collectionName === collection.name),
          { kind, context: ctx, source: mainIdentity, authenticated: trusted() },
          params,
          dates,
        );

      it.each([
        ['list', {}],
        ['get', { filterByTk: 1, fields: ['name'] }],
        ['count', { filter: { name: 'Owned' } }],
      ] as const)('does not invent association paths for root %s', (kind, params) => {
        const sql = vi.spyOn(db.sequelize, 'query');
        expect(plan(params, kind)).toEqual([]);
        expect(sql).not.toHaveBeenCalled();
      });

      it('collects and deduplicates the same path across filter, sort and selection without SQL', () => {
        const sql = vi.spyOn(db.sequelize, 'query');
        const paths = plan({
          fields: ['id', 'project.name'],
          appends: ['project'],
          filter: { project: { name: { $includes: 'a' } } },
          sort: '-project.name,id',
        });
        expect(paths).toEqual([['project']]);
        expect(Object.isFrozen(paths)).toBe(true);
        expect(Object.isFrozen(paths[0])).toBe(true);
        expect(sql).not.toHaveBeenCalled();
      });

      it.each(['list', 'get', 'count'] as const)('collects nested user filters for %s', (kind) => {
        projects.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'projectId' });
        expect(
          plan(
            {
              ...(kind === 'get' ? { filterByTk: 1 } : {}),
              filter: { 'project.parent.name': { $eq: 'Owned' } },
            },
            kind,
          ),
        ).toEqual([['project'], ['project', 'parent']]);
      });

      it('collects nested expansions and leaves unused except paths out', () => {
        projects.setField('parent', { type: 'belongsTo', target: 'documents', foreignKey: 'projectId' });
        expect(plan({ appends: ['project.parent.name'], except: ['project.parent.id'] })).toEqual([
          ['project'],
          ['project', 'parent'],
        ]);
        expect(plan({ except: ['project.name'] })).toEqual([]);
      });

      it('includes a registered many-to-many through path even for selection-only reads', () => {
        docs.setField('links', { type: 'belongsToMany', target: 'projects', through: 'document_projects' });
        const through = db.getCollection('document_projects');
        const resolve = (collection: Collection) =>
          collection === through
            ? { ...mainIdentity, collectionKey: 'through-key', collectionName: through.name }
            : identities.find((identity) => identity.collectionName === collection.name);
        const collect = (params: unknown) =>
          collectRelatedReadPaths(
            db,
            adapter,
            queries,
            resolve,
            {
              kind: 'list',
              context: ctx,
              source: mainIdentity,
              authenticated: trusted(),
            },
            params,
          );
        expect(collect({ appends: ['links.name'] })).toEqual([['links'], ['links', '$through']]);
        expect(collect({ filter: { links: { name: 'Zebra' } } })).toEqual([['links'], ['links', '$through']]);
      });

      it('uses the server clock for date shortcuts without creating authorization-fact paths', () => {
        expect(
          plan({ filter: { 'project.occurredAt': { $dateOn: '{{$nDate.today}}' } } }, 'list', {
            now: '2026-10-19T00:00:00.000Z',
            timezone: '+08:00',
          }),
        ).toEqual([['project']]);
      });

      it.each([
        { appends: ['missing'] },
        { fields: ['project.missing'] },
        { filter: { project: { missing: 1 } } },
        { filter: { project: { name: { $wat: 1 } } } },
        { sort: ['project.missing'] },
        { sort: ['project.name', 'project.name'] },
        { pageSize: 1001 },
        { tree: true },
        { paginate: false },
        { values: {} },
      ])('preserves strict parser rejection for unsupported params %j', (params) => {
        expect(() => plan(params)).toThrow();
      });

      it('snapshots the request before metadata callbacks can mutate it', () => {
        const params = { fields: ['id'], appends: ['project.name'] };
        const paths = collectRelatedReadPaths(
          db,
          adapter,
          queries,
          (collection) => {
            params.appends.length = 0;
            return identities.find((identity) => identity.collectionName === collection.name);
          },
          { kind: 'list', context: ctx, source: mainIdentity, authenticated: trusted() },
          params,
        );
        expect(paths).toEqual([['project']]);
      });

      it('snapshots filter values before resolving the root collection identity', () => {
        const params = { filter: { project: { name: 'Zebra' } } };
        const paths = collectRelatedReadPaths(
          db,
          adapter,
          queries,
          (collection) => {
            Reflect.deleteProperty(params.filter, 'project');
            return identities.find((identity) => identity.collectionName === collection.name);
          },
          { kind: 'list', context: ctx, source: mainIdentity, authenticated: trusted() },
          params,
        );
        expect(paths).toEqual([['project']]);
      });

      it('rejects getter input without invoking it', () => {
        const getter = vi.fn(() => ['project']);
        const params = Object.defineProperty({}, 'appends', { get: getter });
        expect(() => plan(params)).toThrow();
        expect(getter).not.toHaveBeenCalled();
      });

      it.each(['fields', 'appends', 'sort', 'filter'])('does not normalize invalid array prototypes in %s', (key) => {
        const values = key === 'filter' ? [{ name: 'Owned' }] : [key === 'fields' ? 'id' : 'project.name'];
        Object.setPrototypeOf(values, Object.create(Array.prototype));
        expect(() => plan(key === 'filter' ? { filter: { $and: values } } : { [key]: values })).toThrow();
      });

      it('bounds the union of used paths without querying or scanning unused targets', () => {
        for (let index = 0; index < 101; index++)
          docs.setField(`link${index}`, { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
        const filter = Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`link${index}`, { name: 'Zebra' }]),
        );
        const sql = vi.spyOn(db.sequelize, 'query');
        expect(plan({ filter }, 'count')).toHaveLength(100);
        expect(() => plan({ filter: { ...filter, link100: { name: 'Zebra' } } }, 'count')).toThrow(/path limit/);
        expect(sql).not.toHaveBeenCalled();
      });

      it('rejects non-scalar ordering and missing through identities', () => {
        expect(() => plan({ sort: ['project.labels'] })).toThrow(/scalar/);
        docs.setField('links', { type: 'belongsToMany', target: 'projects', through: 'document_projects' });
        expect(() => plan({ appends: ['links.name'] })).toThrow(/identity/);
      });

      it.each(['wrong source', 'other data source', 'unregistered model'])(
        'rejects metadata binding errors: %s',
        (kind) => {
          const resolve = (collection: Collection) => {
            if (kind === 'unregistered model' && collection === projects) db.modelCollection.delete(projects.model);
            const identity = identities.find((identity) => identity.collectionName === collection.name);
            if (
              (kind === 'wrong source' && collection === docs) ||
              (kind === 'other data source' && collection === projects)
            )
              return { ...identity!, dataSourceKey: 'other' };
            return identity;
          };
          const sql = vi.spyOn(db.sequelize, 'query');
          expect(() =>
            collectRelatedReadPaths(
              db,
              adapter,
              queries,
              resolve,
              {
                kind: 'list',
                context: ctx,
                source: mainIdentity,
                authenticated: trusted(),
              },
              { appends: ['project.name'] },
            ),
          ).toThrow();
          expect(sql).not.toHaveBeenCalled();
        },
      );
    });

    describe('related permissions', () => {
      const targetContext = async (permission = {}, raw: Record<string, unknown> = {}, actionName = 'list') => {
        const acl = allowed();
        acl.getRole('reader').grantAction('projects:view', permission);
        // Keep the target context independent: the prepared root fixture reuses ctx.
        return { ...(await authorized(actionName, raw, acl, 'projects')) };
      };
      const relatedHandler = (target: Awaited<ReturnType<typeof targetContext>> | null) => {
        const resolve = vi.fn((_collection, _path, _operation) => target);
        return { handler: createHandler(undefined, resolve), resolve };
      };

      describe('chart handler', () => {
        const values = () => ({
          collection: 'documents',
          dataSource: 'main',
          measures: [{ field: ['amount'], aggregation: 'sum', alias: '金额' }],
          dimensions: [] as Record<string, unknown>[],
          filter: { project: { name: 'Zebra' } },
          cache: { enabled: true, ttl: 60 },
        });

        it.each([false, true])('prepares related list permissions for grouped=%s statistics', async (grouped) => {
          const target = await targetContext({ fields: ['name'] });
          const result = await authorized();
          const query = values();
          if (grouped) query.dimensions = [{ field: 'tenantId', alias: '归属' }];
          const authorize = vi.fn(async () => target);
          await createHandler().handleChartWithRelatedContexts(result, trusted(), query, authorize);
          expect(result.body).toEqual(grouped ? [{ 归属: 'B', 金额: 10 }] : [{ 金额: 10 }]);
          expect(result.paginate).toBe(false);
          expect(authorize).toHaveBeenCalledTimes(1);
          expect(authorize.mock.calls[0]).toEqual([
            projects,
            ['project'],
            { kind: 'list', context: result, source: mainIdentity, authenticated: trusted() },
          ]);
        });

        it('retains final role fields, fixed scope and hidden role facts', async () => {
          const acl = allowed();
          acl.getRole('reader').grantAction('documents:view', {
            fields: ['amount'],
            filter: { 'project.name': '{{ ctx.state.currentUser.projectName }}' },
          });
          acl.addFixedParams('documents', 'list', () => ({ filter: { amount: { $gte: 15 } } }));
          const result = await authorized('list', {}, acl);
          const authorize = vi.fn(async () => null);
          const query = { ...values(), filter: {} };
          await createHandler().handleChartWithRelatedContexts(result, trusted(), query, authorize);
          expect(result.body).toEqual([{ 金额: 20 }]);
          expect(authorize).not.toHaveBeenCalled();
          const sql = vi.spyOn(db.sequelize, 'query');
          await expect(
            createHandler().handleChartWithRelatedContexts(
              result,
              trusted(),
              { ...query, dimensions: [{ field: 'name' }] },
              authorize,
            ),
          ).rejects.toThrow(/authorized/);
          expect(sql).not.toHaveBeenCalled();
          expect(result.body).toEqual([{ 金额: 20 }]);
        });

        it.each(['collection', 'dataSource', 'action', 'filtered', 'denied'])(
          'rejects %s authorization binding before querying or authorizing targets',
          async (kind) => {
            const result = await authorized(
              kind === 'action' ? 'get' : 'list',
              kind === 'action' ? { filterByTk: 1 } : {},
            );
            const query = values();
            if (kind === 'collection') query.collection = 'projects';
            if (kind === 'dataSource') query.dataSource = 'other';
            if (kind === 'filtered')
              Object.assign((result.permission as { rawParams: object }).rawParams, { filter: { id: 1 } });
            if (kind === 'denied') Object.assign(result.permission as object, { can: false });
            const authorize = vi.fn(async () => null);
            const sql = vi.spyOn(db.sequelize, 'query');
            await expect(
              createHandler().handleChartWithRelatedContexts(result, trusted(), query, authorize),
            ).rejects.toThrow();
            expect(authorize).not.toHaveBeenCalled();
            expect(sql).not.toHaveBeenCalled();
            expect(result.body).toBe('unchanged');
          },
        );

        it('does not query with missing target permission', async () => {
          const result = await authorized();
          const sql = vi.spyOn(db.sequelize, 'query');
          await expect(
            createHandler().handleChartWithRelatedContexts(result, trusted(), values(), async () => null),
          ).rejects.toThrow(/authorized/);
          expect(sql).not.toHaveBeenCalled();
          expect(result.body).toBe('unchanged');
        });

        it('captures chart values, role, final permission and dates before awaiting authorization', async () => {
          await docs.model.update({ occurredAt: new Date('2026-10-19T00:00:00Z') }, { where: { id: 1 } });
          const target = await targetContext({ fields: ['name'] });
          const result = await authorized();
          const query = { ...values(), filter: { ...values().filter, occurredAt: { $dateOn: '{{$nDate.today}}' } } };
          const identity = trusted();
          const dates = { now: '2026-10-19T00:00:00Z', timezone: '+08:00' };
          await createHandler().handleChartWithRelatedContexts(
            result,
            identity,
            query,
            async () => {
              query.collection = 'projects';
              query.measures[0].aggregation = 'count';
              query.filter.project.name = 'Secret';
              identity.tenantId = 'C';
              identity.roleName = 'other';
              Object.assign(result.permission as object, { can: false });
              dates.now = '2026-10-20T00:00:00Z';
              return target;
            },
            undefined,
            dates,
          );
          expect(result.body).toEqual([{ 金额: 10 }]);
        });

        it('rejects a replaced configuration phase before statistics SQL', async () => {
          const target = await targetContext();
          const result = await authorized();
          const sql = vi.spyOn(db.sequelize, 'query');
          await expect(
            createHandler().handleChartWithRelatedContexts(result, trusted(), values(), async () => {
              adapter.release(result);
              await adapter.prepare(result, identities);
              sql.mockClear();
              return target;
            }),
          ).rejects.toThrow(/phase/);
          expect(sql).not.toHaveBeenCalled();
          expect(result.body).toBe('unchanged');
        });

        it('uses the caller transaction and rechecks cache-enabled requests', async () => {
          const result = await authorized();
          const query = { ...values(), filter: {} };
          const authorize = vi.fn(async () => null);
          const transaction = await db.sequelize.transaction();
          try {
            await docs.model.update({ amount: 11 }, { where: { id: 1 }, transaction });
            await createHandler().handleChartWithRelatedContexts(result, trusted(), query, authorize, transaction);
            expect(result.body).toEqual([{ 金额: 121 }]);
          } finally {
            await transaction.rollback();
          }
          await createHandler().handleChartWithRelatedContexts(result, trusted(), query, authorize);
          expect(result.body).toEqual([{ 金额: 120 }]);
          Object.assign(result.permission as object, { can: false });
          const sql = vi.spyOn(db.sequelize, 'query');
          await expect(
            createHandler().handleChartWithRelatedContexts(result, trusted(), query, authorize),
          ).rejects.toThrow(/authorized/);
          expect(sql).not.toHaveBeenCalled();
        });
      });

      describe('automatic preparation', () => {
        it.each(['list', 'get', 'count'] as const)('prepares used paths for root %s', async (kind) => {
          const target = await targetContext({ fields: ['name'], filter: { name: 'Zebra' } });
          const result = await authorized(kind, {
            filter: { project: { name: { $includes: 'a' } } },
            ...(kind === 'count' ? {} : { fields: ['id'], appends: ['project'] }),
            ...(kind === 'list' ? { sort: ['project.name'] } : {}),
            ...(kind === 'get' ? { filterByTk: 1 } : {}),
          });
          const authorize = vi.fn(async () => target);
          await createHandler().handleWithRelatedContexts(result, trusted(), authorize);
          expect(authorize).toHaveBeenCalledTimes(1);
          expect(authorize.mock.calls[0]).toEqual([
            projects,
            ['project'],
            {
              kind,
              context: result,
              source: mainIdentity,
              authenticated: trusted(),
            },
          ]);
          expect(result.body).toEqual(
            kind === 'count'
              ? 1
              : kind === 'get'
                ? { id: 1, project: { name: 'Zebra' } }
                : { rows: [{ id: 1, project: { name: 'Zebra' } }], count: 1, page: 1, pageSize: 20, totalPage: 1 },
          );
        });

        it('does not request unused target permissions', async () => {
          const result = await authorized('count', { filter: { name: 'Owned' } });
          const authorize = vi.fn(async () => null);
          await createHandler().handleWithRelatedContexts(result, trusted(), authorize);
          expect(result.body).toBe(1);
          expect(authorize).not.toHaveBeenCalled();
        });

        it('keeps concurrent requests and their target decisions independent', async () => {
          const zebra = await targetContext({ fields: ['name'], filter: { name: 'Zebra' } });
          const alpha = await targetContext({ fields: ['name'], filter: { name: 'Alpha' } });
          const first = { ...(await authorized('get', { filterByTk: 1, fields: ['id'], appends: ['project'] })) };
          const second = { ...(await authorized('get', { filterByTk: 4, fields: ['id'], appends: ['project'] })) };
          await adapter.prepare(first, identities);
          await adapter.prepare(second, identities);
          let release!: () => void;
          const wait = new Promise<void>((resolve) => {
            release = resolve;
          });
          const handler = createHandler();
          const pending = handler.handleWithRelatedContexts(first, trusted(), async () => {
            await wait;
            return zebra;
          });
          try {
            await handler.handleWithRelatedContexts(second, trusted(), async () => alpha);
            expect(second.body).toEqual({ id: 4, project: { name: 'Alpha' } });
            expect(first.body).toBe('unchanged');
          } finally {
            release();
            await pending;
          }
          expect(first.body).toEqual({ id: 1, project: { name: 'Zebra' } });
        });

        it('captures root parameters, final permission and identity before awaiting target authorization', async () => {
          const target = await targetContext({ fields: ['name'] });
          const acl = allowed();
          acl
            .getRole('reader')
            .grantAction('documents:view', { fields: ['id'], appends: ['project'], filter: { id: 1 } });
          const result = await authorized(
            'list',
            { fields: ['id'], appends: ['project'], sort: ['project.name'] },
            acl,
          );
          const identity = trusted();
          await createHandler().handleWithRelatedContexts(result, identity, async () => {
            await Promise.resolve();
            Object.assign(identity, { tenantId: 'C', roleName: 'other' });
            Object.assign((result.permission as { parsedParams: object }).parsedParams, {
              fields: ['name'],
              filter: {},
            });
            Object.assign((result.permission as { rawParams: object }).rawParams, {
              fields: ['name'],
              appends: [],
              filter: { id: 2 },
            });
            Object.assign(result.action, { resourceName: 'projects', actionName: 'count' });
            return target;
          });
          expect(result.body).toMatchObject({ rows: [{ id: 1, project: { name: 'Zebra' } }], count: 1 });
          expect(result.paginate).toBe(true);
        });

        it('preserves the captured date context while awaiting authorization', async () => {
          await docs.model.update({ occurredAt: new Date('2026-10-19T00:00:00.000Z') }, { where: { id: 1 } });
          const target = await targetContext({ fields: ['name'] });
          const result = await authorized('list', {
            fields: ['id'],
            appends: ['project'],
            filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } },
          });
          const dates = { now: '2026-10-19T00:00:00.000Z', timezone: '+08:00' };
          await createHandler().handleWithRelatedContexts(
            result,
            trusted(),
            async () => {
              dates.now = '2026-10-20T00:00:00.000Z';
              dates.timezone = '-08:00';
              return target;
            },
            undefined,
            dates,
          );
          expect(result.body).toMatchObject({ rows: [{ id: 1, project: { name: 'Zebra' } }], count: 1 });
        });

        it('retains root rows while hiding target data outside G/V', async () => {
          const target = await targetContext({ fields: ['name'] });
          const result = await authorized('get', { filterByTk: 2, fields: ['id'], appends: ['project'] });
          await createHandler().handleWithRelatedContexts(result, trusted(), async () => target);
          expect(result.body).toEqual({ id: 2, project: null });
        });

        it('uses the caller transaction for uncommitted root records', async () => {
          const target = await targetContext({ fields: ['name'] });
          const result = await authorized('get', { filterByTk: 9, fields: ['id'], appends: ['project'] });
          const transaction = await db.sequelize.transaction();
          try {
            await docs.model.create({ id: 9, tenantId: 'B', projectId: 101, name: 'Uncommitted' }, { transaction });
            await createHandler().handleWithRelatedContexts(result, trusted(), async () => target, transaction);
            expect(result.body).toEqual({ id: 9, project: { name: 'Zebra' } });
          } finally {
            await transaction.rollback();
          }
          expect(await docs.model.findByPk(9)).toBeNull();
        });

        it('does not reuse root authorization after replacing its prepared configuration phase', async () => {
          const target = await targetContext();
          const result = await authorized('list', { appends: ['project'] });
          const find = vi.spyOn(docs.model, 'findAll');
          await expect(
            createHandler().handleWithRelatedContexts(result, trusted(), async () => {
              adapter.release(result);
              await adapter.prepare(result, identities);
              return target;
            }),
          ).rejects.toThrow(/phase/);
          expect(find).not.toHaveBeenCalled();
          expect(result.body).toBe('unchanged');
        });

        it.each(['list', 'get', 'count'] as const)(
          'rejects invalid request array prototypes before authorization for %s',
          async (kind) => {
            const result = await authorized(kind, kind === 'get' ? { filterByTk: 1 } : {});
            const values = [{ name: 'Owned' }];
            Object.setPrototypeOf(values, Object.create(Array.prototype));
            Object.assign((result.permission as { rawParams: object }).rawParams, { filter: { $and: values } });
            const authorize = vi.fn(async () => null);
            const sql = vi.spyOn(db.sequelize, 'query');
            await expect(createHandler().handleWithRelatedContexts(result, trusted(), authorize)).rejects.toThrow(
              /dense/,
            );
            expect(authorize).not.toHaveBeenCalled();
            expect(sql).not.toHaveBeenCalled();
          },
        );

        it.each(['missing', 'denied'] as const)('does not query for %s target permission', async (kind) => {
          const target = await targetContext();
          if (kind === 'denied') Object.assign(target.permission as object, { can: false });
          const result = await authorized('get', { filterByTk: 1, appends: ['project'] });
          const sql = vi.spyOn(db.sequelize, 'query');
          await expect(
            createHandler().handleWithRelatedContexts(result, trusted(), async () =>
              kind === 'missing' ? null : target,
            ),
          ).rejects.toThrow(/authorized/);
          expect(sql).not.toHaveBeenCalled();
          expect(result.body).toBe('unchanged');
        });

        it('does not authorize targets for a denied root read', async () => {
          const result = await authorized('list', { appends: ['project'] });
          Object.assign(result.permission as object, { can: false });
          const authorize = vi.fn(async () => null);
          const sql = vi.spyOn(db.sequelize, 'query');
          await expect(createHandler().handleWithRelatedContexts(result, trusted(), authorize)).rejects.toThrow(
            /authorized/,
          );
          expect(authorize).not.toHaveBeenCalled();
          expect(sql).not.toHaveBeenCalled();
          expect(result.body).toBe('unchanged');
        });

        it('propagates target preparation errors without querying or replacing the response', async () => {
          const result = await authorized('list', { appends: ['project'] });
          const failure = new Error('target authorization failed');
          const sql = vi.spyOn(db.sequelize, 'query');
          await expect(
            createHandler().handleWithRelatedContexts(result, trusted(), async () => {
              throw failure;
            }),
          ).rejects.toBe(failure);
          expect(sql).not.toHaveBeenCalled();
          expect(result.body).toBe('unchanged');
        });

        it.each(['relation', 'phase'] as const)(
          'rejects changed %s during authorization before business SQL',
          async (kind) => {
            const target = await targetContext();
            const result = await authorized('list', { appends: ['project'] });
            const sql = vi.spyOn(db.sequelize, 'query');
            await expect(
              createHandler().handleWithRelatedContexts(result, trusted(), async () => {
                if (kind === 'relation') Object.assign(docs.model.associations.project, { target: docs.model });
                else adapter.release(result);
                return target;
              }),
            ).rejects.toThrow();
            expect(sql).not.toHaveBeenCalled();
            expect(result.body).toBe('unchanged');
          },
        );
      });

      it('uses asynchronously prepared permissions for real filtered and expanded root reads', async () => {
        const target = await targetContext({ fields: ['name'], filter: { name: 'Zebra' } });
        const params = {
          fields: ['id'],
          appends: ['project'],
          filter: { project: { name: { $includes: 'a' } } },
          sort: ['project.name'],
        };
        const result = await authorized('list', params);
        const operation = { kind: 'list' as const, context: result, source: mainIdentity, authenticated: trusted() };
        const resolveIdentity = (collection: Collection) =>
          identities.find((identity) => identity.collectionName === collection.name);
        const paths = collectRelatedReadPaths(db, adapter, queries, resolveIdentity, operation, params);
        const authorize = vi.fn(async () => target);
        const resolve = await prepareRelatedReadContexts(db, resolveIdentity, operation, paths, authorize);
        expect(authorize).toHaveBeenCalledTimes(1);
        Object.assign((target.permission as { parsedParams: object }).parsedParams, { fields: [], filter: {} });
        await createHandler(undefined, resolve).handle(result, trusted());
        expect(result.body).toEqual({
          rows: [{ id: 1, project: { name: 'Zebra' } }],
          count: 1,
          page: 1,
          pageSize: 20,
          totalPage: 1,
        });
      });

      it('retains root rows while asynchronously prepared target G/V hides associated data', async () => {
        const target = await targetContext({ fields: ['name'] });
        const params = { filterByTk: 2, fields: ['id'], appends: ['project'] };
        const result = await authorized('get', params);
        const operation = { kind: 'get' as const, context: result, source: mainIdentity, authenticated: trusted() };
        const resolveIdentity = (collection: Collection) =>
          identities.find((identity) => identity.collectionName === collection.name);
        const resolve = await prepareRelatedReadContexts(
          db,
          resolveIdentity,
          operation,
          collectRelatedReadPaths(db, adapter, queries, resolveIdentity, operation, params),
          async () => target,
        );
        await createHandler(undefined, resolve).handle(result, trusted());
        expect(result.body).toEqual({ id: 2, project: null });
      });

      it.each(['missing target', 'target field', 'parent field'])(
        'path planning does not grant access: %s',
        async (kind) => {
          const target = await targetContext({ fields: kind === 'target field' ? ['id'] : ['name'] });
          const acl = allowed();
          if (kind === 'parent field') acl.getRole('reader').grantAction('documents:view', { fields: ['id'] });
          const params = { fields: ['id'], filter: { project: { name: 'Zebra' } } };
          const result = await authorized('list', params, acl);
          const operation = { kind: 'list' as const, context: result, source: mainIdentity, authenticated: trusted() };
          const resolveIdentity = (collection: Collection) =>
            identities.find((identity) => identity.collectionName === collection.name);
          const sql = vi.spyOn(db.sequelize, 'query');
          const paths = collectRelatedReadPaths(db, adapter, queries, resolveIdentity, operation, params);
          const resolve = await prepareRelatedReadContexts(db, resolveIdentity, operation, paths, async () =>
            kind === 'missing target' ? null : target,
          );
          await expect(createHandler(undefined, resolve).handle(result, trusted())).rejects.toThrow(/authorized/);
          expect(result.body).toBe('unchanged');
          expect(sql).not.toHaveBeenCalled();
        },
      );

      it('does not request target permissions for internal role-filter relationship facts', async () => {
        const acl = allowed();
        acl
          .getRole('reader')
          .grantAction('documents:view', { fields: ['id'], filter: { project: { name: 'Secret' } } });
        const params = { fields: ['id'] };
        const result = await authorized('list', params, acl);
        const operation = { kind: 'list' as const, context: result, source: mainIdentity, authenticated: trusted() };
        const resolveIdentity = (collection: Collection) =>
          identities.find((identity) => identity.collectionName === collection.name);
        const paths = collectRelatedReadPaths(db, adapter, queries, resolveIdentity, operation, params);
        const authorize = vi.fn(async () => null);
        const resolve = await prepareRelatedReadContexts(db, resolveIdentity, operation, paths, authorize);
        await createHandler(undefined, resolve).handle(result, trusted());
        expect(paths).toEqual([]);
        expect(authorize).not.toHaveBeenCalled();
        expect(result.body).toMatchObject({ rows: [{ id: 2 }], count: 1 });
      });

      it('expands only readable target rows while retaining every readable root and native count', async () => {
        const target = await targetContext({ fields: ['name'] });
        const result = await authorized('list', { fields: ['id'], appends: ['project'], sort: ['id'] });
        const { handler, resolve } = relatedHandler(target);
        await handler.handle(result, trusted());
        expect(result.body).toEqual({
          rows: [
            { id: 1, project: { name: 'Zebra' } },
            { id: 2, project: null },
            { id: 4, project: { name: 'Alpha' } },
            { id: 5, project: null },
          ],
          count: 4,
          page: 1,
          pageSize: 20,
          totalPage: 1,
        });
        expect(resolve).toHaveBeenCalledTimes(1);
        const [collection, path, operation] = resolve.mock.calls[0];
        expect(collection).toBe(projects);
        expect(path).toEqual(['project']);
        expect(Object.isFrozen(path)).toBe(true);
        expect(operation).toMatchObject({ kind: 'list', authenticated: trusted(), source: mainIdentity });
        expect(Object.isFrozen(operation.authenticated)).toBe(true);
      });

      it.each(['list', 'get', 'count'])(
        'uses target list permission for related filtering during root %s',
        async (kind) => {
          const target = await targetContext({ fields: ['name'], filter: { name: 'Zebra' } });
          const result = await authorized(kind, {
            filter: { project: { name: { $includes: 'a' } } },
            ...(kind === 'count' ? {} : { fields: ['id'] }),
            ...(kind === 'get' ? { filterByTk: 1 } : {}),
          });
          const { handler } = relatedHandler(target);
          await handler.handle(result, trusted());
          expect(result.body).toEqual(
            kind === 'count'
              ? 1
              : kind === 'get'
                ? { id: 1 }
                : {
                    rows: [{ id: 1 }],
                    count: 1,
                    page: 1,
                    pageSize: 20,
                    totalPage: 1,
                  },
          );
        },
      );

      it('sorts with target role and G/V restrictions and reuses one per-path decision across query uses', async () => {
        const target = await targetContext({ fields: ['name'], filter: { name: 'Alpha' } });
        const result = await authorized('list', { fields: ['id'], appends: ['project'], sort: ['project.name', 'id'] });
        const { handler, resolve } = relatedHandler(target);
        await handler.handle(result, trusted());
        expect(result.body).toMatchObject({
          rows: [
            { id: 4, project: { name: 'Alpha' } },
            { id: 1, project: null },
            { id: 2, project: null },
            { id: 5, project: null },
          ],
          count: 4,
        });
        expect(resolve).toHaveBeenCalledTimes(1);
      });

      it('intersects the parent permission path with the target field grant', async () => {
        const target = await targetContext({ fields: ['id', 'name'] });
        const acl = allowed();
        acl.getRole('reader').grantAction('documents:view', { fields: ['id'], appends: ['project.name'] });
        const result = await authorized('get', { filterByTk: 1, appends: ['project'] }, acl);
        const { handler } = relatedHandler(target);
        await handler.handle(result, trusted());
        expect(result.body).toEqual({ id: 1, project: { name: 'Zebra' } });
        const forbidden = await authorized('get', { filterByTk: 1, fields: ['id', 'project.id'] }, acl);
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(handler.handle(forbidden, trusted())).rejects.toThrow(/authorized/);
        expect(sql).not.toHaveBeenCalled();
      });

      it('keeps G/V for target skip authorization', async () => {
        const acl = allowed();
        acl.allow('projects', 'list', () => true);
        acl.addFixedParams('projects', 'list', () => ({ fields: ['name'] }));
        const target = { ...(await authorized('list', {}, acl, 'projects')) };
        const result = await authorized('get', { filterByTk: 2, appends: ['project'], fields: ['id'] });
        await relatedHandler(target).handler.handle(result, trusted());
        expect(result.body).toEqual({ id: 2, project: null });
      });

      it('denies absent or explicitly denied target permissions without querying', async () => {
        const denied = await targetContext();
        Object.assign(denied.permission as object, { can: false });
        const result = await authorized('list', { fields: ['id'], appends: ['project'] });
        const sql = vi.spyOn(db.sequelize, 'query');
        for (const target of [null, denied]) {
          await expect(relatedHandler(target).handler.handle(result, trusted())).rejects.toThrow(/authorized/);
          expect(result.body).toBe('unchanged');
        }
        expect(sql).not.toHaveBeenCalled();
      });

      it.each([
        { filter: {} },
        { filter: { id: 101 } },
        { filterByTk: 101 },
        { fields: ['name'] },
        { appends: [] },
        { page: 2 },
        { tenantId: 'B' },
      ])('does not widen a target decision made with request constraints %j', async (raw) => {
        const target = await targetContext({}, raw);
        const result = await authorized('list', { fields: ['id'], appends: ['project'] });
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(relatedHandler(target).handler.handle(result, trusted())).rejects.toThrow();
        expect(result.body).toBe('unchanged');
        expect(sql).not.toHaveBeenCalled();
      });

      it('requires the correct target database, collection, role and finalized list action', async () => {
        const target = await targetContext();
        const detail = await targetContext({}, { filterByTk: 101 }, 'get');
        const result = await authorized('list', { fields: ['id'], appends: ['project'] });
        const sql = vi.spyOn(db.sequelize, 'query');
        for (const wrong of [
          { ...target, db: {} as Database },
          { ...target, action: { resourceName: 'documents', actionName: 'list' } },
          { ...target, action: { resourceName: 'projects', actionName: 'list', sourceId: '_' } },
          {
            ...target,
            permission: {
              ...(target.permission as object),
              can: { resource: 'projects', action: 'list', role: 'other' },
            },
          },
          { ...target, permission: { ...(target.permission as object), parsedParams: undefined } },
          { ...target, permission: { ...(target.permission as object), rawParams: undefined } },
          detail,
        ])
          await expect(createHandler(undefined, () => wrong).handle(result, trusted())).rejects.toThrow();
        expect(sql).not.toHaveBeenCalled();
        expect(result.body).toBe('unchanged');
      });

      it('captures final target params before later metadata callbacks mutate them', async () => {
        const target = await targetContext({ fields: ['name'], filter: { name: 'Zebra' } });
        let captured = false;
        const result = await authorized('list', { fields: ['id'], appends: ['project'], sort: ['id'] });
        const handler = createHandler(
          (collection) => {
            if (captured)
              Object.assign((target.permission as { parsedParams: object }).parsedParams, {
                fields: ['id'],
                filter: { name: 'Alpha' },
              });
            return identities.find((identity) => identity.collectionName === collection.name);
          },
          () => {
            captured = true;
            return target;
          },
        );
        await handler.handle(result, trusted());
        expect(result.body).toMatchObject({
          rows: [
            { id: 1, project: { name: 'Zebra' } },
            { id: 2, project: null },
            { id: 4, project: null },
            { id: 5, project: null },
          ],
        });
      });

      it('captures target decisions again on a subsequent request instead of sharing grants', async () => {
        const target = await targetContext({ fields: ['name'], filter: { name: 'Zebra' } });
        const { handler, resolve } = relatedHandler(target);
        const first = await authorized('get', { filterByTk: 1, fields: ['id'], appends: ['project'] });
        await handler.handle(first, trusted());
        expect(first.body).toEqual({ id: 1, project: { name: 'Zebra' } });
        Object.assign((target.permission as { parsedParams: object }).parsedParams, { filter: { name: 'Alpha' } });
        const second = await authorized('get', { filterByTk: 1, fields: ['id'], appends: ['project'] });
        await handler.handle(second, trusted());
        expect(second.body).toEqual({ id: 1, project: null });
        expect(resolve).toHaveBeenCalledTimes(2);
      });

      it('keeps distinct decisions for two association paths reaching the same target table', async () => {
        docs.setField('alternateProject', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
        ctx = {};
        await adapter.prepare(ctx, identities);
        const zebra = await targetContext({ fields: ['name'], filter: { name: 'Zebra' } });
        const alpha = await targetContext({ fields: ['name'], filter: { name: 'Alpha' } });
        const result = await authorized('list', {
          fields: ['id'],
          appends: ['project', 'alternateProject'],
          sort: ['id'],
        });
        const resolve = vi.fn<AccessRelatedReadContextResolver>((_collection, path) =>
          path[0] === 'project' ? zebra : alpha,
        );
        await createHandler(undefined, resolve).handle(result, trusted());
        expect(result.body).toMatchObject({
          rows: [
            { id: 1, project: { name: 'Zebra' }, alternateProject: null },
            { id: 2, project: null, alternateProject: null },
            { id: 4, project: null, alternateProject: { name: 'Alpha' } },
            { id: 5, project: null, alternateProject: null },
          ],
        });
        expect(resolve).toHaveBeenCalledTimes(2);
      });
    });

    it('uses raw client filters and finalized hidden role facts with native pagination', async () => {
      const acl = new ACL();
      acl.setAvailableAction('view', { aliases: ['list', 'get'] });
      acl.define({ role: 'reader' }).grantAction('documents:view', {
        fields: ['amount'],
        appends: [],
        filter: { 'project.name': '{{ ctx.state.currentUser.projectName }}' },
      });
      acl.addFixedParams('documents', 'list', () => ({ filter: { amount: { $gte: 15 } } }));
      const result = context('list', {
        fields: ['amount'],
        page: '1',
        pageSize: '2',
        filter: { amount: { $lte: 30 } },
      });
      await acl.middleware()(result as never, async () => {
        expect(JSON.stringify(result.action.params.filter)).toContain('"project":{"name":"Secret"}');
        await createHandler().handle(result, trusted());
      });
      expect(result.body).toEqual({ rows: [{ amount: 20 }], count: 1, page: 1, pageSize: 2, totalPage: 1 });
      expect(result.paginate).toBe(true);
    });

    it('preserves root G/V and the native page count independently of page size', async () => {
      const result = await authorized('list', { fields: ['id'], sort: ['id'], page: '2', pageSize: '2' });
      await createHandler().handle(result, trusted());
      expect(result.body).toEqual({ rows: [{ id: 4 }, { id: 5 }], count: 4, page: 2, pageSize: 2, totalPage: 2 });
    });

    it.each([1, 2, 3, 4, 6, 7, 99])(
      'returns native detail or null for key %s without changing pagination',
      async (key) => {
        const result = await authorized('get', { filterByTk: key, fields: ['id'] });
        await createHandler().handle(result, trusted());
        expect(result.body).toEqual([1, 2, 4].includes(key) ? { id: key } : null);
        expect(result.paginate).toBe(false);
      },
    );

    it('accepts matching REST locator metadata without exposing it as query input', async () => {
      const result = await authorized('get', { resourceIndex: '2', filterByTk: '2', fields: ['id'] });
      await createHandler().handle(result, trusted());
      expect(result.body).toEqual({ id: 2 });
    });

    it('returns a scalar count under independent count permission and role filtering', async () => {
      const acl = allowed();
      acl.getRole('reader').grantAction('documents:count', { filter: { amount: { $gte: 20 } } });
      const result = await authorized('count', { filter: { amount: { $lte: 40 } } }, acl);
      await createHandler().handle(result, trusted());
      expect(result.body).toBe(2);
      expect(result.paginate).toBe(false);
    });

    it('keeps G/V when core grants skip and rejects missing count operation permission before SQL', async () => {
      const acl = new ACL();
      acl.define({ role: 'reader' });
      acl.allow('documents', 'list', () => true);
      acl.addFixedParams('documents', 'list', () => ({ fields: ['id'], filter: { amount: { $gte: 20 } } }));
      const result = await authorized('list', { fields: ['id'], sort: ['id'] }, acl);
      await createHandler().handle(result, trusted());
      expect(result.body).toMatchObject({ count: 3, rows: [{ id: 2 }, { id: 4 }, { id: 5 }] });
      const listOnly = new ACL();
      listOnly.setAvailableAction('view', { aliases: ['list', 'get'] });
      listOnly.define({ role: 'reader' }).grantAction('documents:view', {});
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(authorized('count', {}, listOnly)).rejects.toThrow('403');
      expect(sql).not.toHaveBeenCalled();
    });

    it.each([{ filter: { project: { name: 'Secret' } } }, { sort: ['project.name'] }, { appends: ['project'] }])(
      'does not reuse root authorization for related user query %j',
      async (params) => {
        const result = await authorized('list', params);
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(createHandler().handle(result, trusted())).rejects.toThrow(/authorized/);
        expect(result.body).toBe('unchanged');
        expect(sql).not.toHaveBeenCalled();
      },
    );

    it.each([
      { resourceName: 'projects' },
      { actionName: 'get' },
      { associatedName: 'documents' },
      { associatedIndex: '_' },
      { resourceIndex: '1' },
      { filterByTk: '1' },
      { tenantId: 'C' },
      { transaction: {} },
      { rawParams: {} },
      { sql: 'SELECT 1' },
      { values: {} },
      { unknown: undefined },
    ])('rejects contradictory transport or unsupported inputs %j before SQL', async (extra) => {
      const result = await authorized('list', { fields: ['id'] });
      Object.assign((result.permission as { rawParams: object }).rawParams, extra);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(createHandler().handle(result, trusted())).rejects.toThrow();
      expect(result.body).toBe('unchanged');
      expect(result.paginate).toBe(false);
      expect(sql).not.toHaveBeenCalled();
    });

    it('rejects conflicting REST and query keys', async () => {
      const result = await authorized('get', { resourceIndex: '1', filterByTk: 2 });
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(createHandler().handle(result, trusted())).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    });

    it('requires raw params and never falls back to merged action params', async () => {
      const result = await authorized('list', { fields: ['id'] });
      delete (result.permission as { rawParams?: unknown }).rawParams;
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(createHandler().handle(result, trusted())).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    });

    it('binds the configured database, requested root action and authenticated role', async () => {
      const result = await authorized('list', { fields: ['id'] });
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(createHandler().handle({ ...result, db: {} as Database }, trusted())).rejects.toThrow();
      await expect(createHandler().handle(result, { ...trusted(), roleName: 'other' })).rejects.toThrow();
      for (const action of [
        { ...result.action, resourceName: 'documents.project' },
        { ...result.action, sourceId: '_' },
        { ...result.action, resourceOf: 1 },
        { ...result.action, actionName: 'sum' },
      ])
        await expect(createHandler().handle({ ...result, action }, trusted())).rejects.toThrow();
      expect(result.body).toBe('unchanged');
      expect(sql).not.toHaveBeenCalled();
    });

    it('rejects raw request and identity accessors without executing them', async () => {
      const result = await authorized('list', { fields: ['id'] });
      const permission = result.permission as { rawParams: Record<string, unknown> };
      const getter = vi.fn(() => ({ id: 1 }));
      Object.defineProperty(permission.rawParams, 'filter', { get: getter, configurable: true });
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(createHandler().handle(result, trusted())).rejects.toThrow();
      delete permission.rawParams.filter;
      await expect(
        createHandler().handle(result, Object.defineProperty(trusted(), 'roleName', { get: getter })),
      ).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
    });

    it('captures identity, raw inputs, final permission and dates before metadata callbacks', async () => {
      await docs.model.update({ occurredAt: new Date('2026-09-16T00:00:00Z') }, { where: { id: 1 } });
      const result = await authorized('list', {
        fields: ['id'],
        filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } },
      });
      const identity = trusted();
      const dates = { now: '2026-09-16T12:00:00.000Z', timezone: '+08:00' };
      const handler = createHandler((collection) => {
        identity.tenantId = 'C';
        identity.roleName = 'other';
        dates.now = '2026-09-17T12:00:00.000Z';
        const permission = result.permission as { rawParams: object; parsedParams: object };
        Object.assign(permission.rawParams, { filter: { id: 3 }, fields: ['name'] });
        Object.assign(permission.parsedParams, { filter: { id: 3 } });
        return identities.find((item) => item.collectionName === collection.name);
      });
      await handler.handle(result, identity, undefined, dates);
      expect(result.body).toMatchObject({ rows: [{ id: 1 }], count: 1 });
    });
  });

  describe('chart params', () => {
    const chart = (extra: Record<string, unknown> = {}) =>
      entryReads.chartFromParams(ctx, mainIdentity, auth, {
        measures: [{ field: ['amount'], aggregation: 'sum', alias: '金额' }],
        dimensions: [{ field: ['tenantId'], alias: '归属' }],
        orders: [],
        ...extra,
      });

    describe('date grouping', () => {
      const dateChart = (extra: Record<string, unknown> = {}, timezone = '+08:00') =>
        entryReads.chartFromParams(
          ctx,
          mainIdentity,
          auth,
          {
            measures: [{ field: 'amount', aggregation: 'sum', alias: '金额' }],
            dimensions: [{ field: 'occurredAt', alias: '日期', format: 'YYYY-MM-DD' }],
            ...extra,
          },
          undefined,
          { now: '2026-09-16T12:00:00.000Z', timezone },
        );

      beforeEach(async () => {
        for (const [id, instant] of [
          [1, '2026-12-31T15:59:59.999Z'],
          [2, '2026-12-31T16:00:00.000Z'],
          [3, '2026-12-31T16:00:00.000Z'],
          [4, '2027-01-31T16:00:00.000Z'],
        ] as const)
          await docs.model.update({ occurredAt: new Date(instant) }, { where: { id } });
      });

      it.each([
        ['YYYY-MM-DD', ['2026-12-31', '2027-01-01', '2027-02-01']],
        ['YYYY-MM', ['2026-12', '2027-01', '2027-02']],
        ['YYYY', ['2026', '2027']],
      ])('groups authorized dates by %s without coercing strings back into dates', async (format, keys) => {
        const rows = await dateChart({ dimensions: [{ field: 'occurredAt', format, alias: '日期', type: 'string' }] });
        expect(rows).toEqual(
          keys.length === 2
            ? [
                { 日期: keys[0], 金额: 10 },
                { 日期: keys[1], 金额: 60 },
                { 日期: null, 金额: 50 },
              ]
            : [
                { 日期: keys[0], 金额: 10 },
                { 日期: keys[1], 金额: 20 },
                { 日期: keys[2], 金额: 40 },
                { 日期: null, 金额: 50 },
              ],
        );
      });

      it('uses negative and fractional offsets and leaves pure calendar dates unchanged', async () => {
        expect(await dateChart({}, '-05:30')).toEqual([
          { 日期: '2026-12-31', 金额: 30 },
          { 日期: '2027-01-31', 金额: 40 },
          { 日期: null, 金额: 50 },
        ]);
        await docs.model.update({ calendarDate: '2027-01-01' }, { where: { id: [1, 2, 3, 4] } });
        for (const timezone of ['+14:00', '-14:00'])
          expect(
            await dateChart(
              {
                dimensions: [{ field: 'calendarDate', format: 'YYYY-MM-DD' }],
              },
              timezone,
            ),
          ).toEqual([
            { calendarDate: '2027-01-01', 金额: 70 },
            { calendarDate: null, 金额: 50 },
          ]);
        expect(await dateChart({}, '+08:30')).toEqual([
          { 日期: '2027-01-01', 金额: 30 },
          { 日期: '2027-02-01', 金额: 40 },
          { 日期: null, 金额: 50 },
        ]);
      });

      it('shares formatted groups across measures and SQL ordering, preserving NULL and group limits', async () => {
        const params = {
          measures: [
            { field: 'amount', aggregation: 'sum', alias: '金额' },
            { field: 'id', aggregation: 'count', alias: '数量' },
          ],
          dimensions: [
            { field: 'occurredAt', format: 'YYYY', alias: '年' },
            { field: 'tenantId', alias: '归属' },
          ],
          orders: [
            { alias: '年', order: 'desc' },
            { alias: '数量', order: 'desc' },
          ],
        };
        expect(await dateChart(params)).toEqual([
          { 年: '2027', 归属: 'H', 金额: 20, 数量: 1 },
          { 年: '2027', 归属: null, 金额: 40, 数量: 1 },
          { 年: '2026', 归属: 'B', 金额: 10, 数量: 1 },
          { 年: null, 归属: 'B', 金额: 50, 数量: 1 },
        ]);
        await expect(dateChart({ ...params, limit: 3 })).rejects.toThrow(/group limit/);
        expect(await dateChart({ filter: { amount: 30 } })).toEqual([]);
      });

      it('intersects role, relationship and date filters and independently requires the grouping field grant', async () => {
        permissions.set('', {
          allowed: true,
          params: { fields: ['amount', 'occurredAt'], filter: { amount: { $gte: 20 } } },
        });
        expect(await dateChart({ filter: { occurredAt: { $dateOn: '2027+08:00' } } })).toEqual([
          { 日期: '2027-01-01', 金额: 20 },
          { 日期: '2027-02-01', 金额: 40 },
        ]);
        permissions.set('', { allowed: true, params: {} });
        expect(await dateChart({ filter: { project: { name: 'Zebra' } } })).toEqual([{ 日期: '2026-12-31', 金额: 10 }]);
        permissions.set('', { allowed: true, params: { fields: ['amount'] } });
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(dateChart()).rejects.toThrow(/authorized/);
        expect(sql).not.toHaveBeenCalled();
      });

      it('captures format and trusted timezone before permission callbacks', async () => {
        const dates = { now: '2026-09-16T12:00:00.000Z', timezone: '+08:00' };
        const params = {
          measures: [{ field: 'id', aggregation: 'count' }],
          dimensions: [{ field: 'occurredAt', format: 'YYYY' }],
        };
        entryResolver.mockImplementation(() => {
          dates.timezone = '-05:00';
          params.dimensions[0].format = 'YYYY-MM-DD';
          return { allowed: true, params: {} };
        });
        expect(await entryReads.chartFromParams(ctx, mainIdentity, auth, params, undefined, dates)).toEqual([
          { occurredAt: '2026', id: 1 },
          { occurredAt: '2027', id: 2 },
          { occurredAt: null, id: 1 },
        ]);
      });

      it('uses one aggregate SQL and the supplied transaction without claiming legacy data', async () => {
        const transaction = await db.sequelize.transaction();
        try {
          await docs.model.update(
            { occurredAt: new Date('2028-03-01T00:00:00Z'), amount: 99 },
            { where: { id: 4 }, transaction },
          );
          const find = vi.spyOn(docs.model, 'findAll');
          expect(
            await entryReads.chartFromParams(
              ctx,
              mainIdentity,
              auth,
              {
                measures: [
                  { field: 'amount', aggregation: 'sum' },
                  { field: 'id', aggregation: 'count' },
                ],
                dimensions: [{ field: 'occurredAt', format: 'YYYY-MM' }],
                filter: { occurredAt: { $dateOn: '2028' } },
              },
              transaction,
              { now: '2026-09-16T12:00:00.000Z', timezone: '+08:00' },
            ),
          ).toEqual([{ occurredAt: '2028-03', amount: 99, id: 1 }]);
          expect(find).toHaveBeenCalledTimes(1);
          expect(find.mock.calls[0][0]?.transaction).toBe(transaction);
          expect((await docs.model.findByPk(4, { transaction }))!.getDataValue('tenantId')).toBeNull();
        } finally {
          await transaction.rollback();
        }
        expect(await dateChart({ filter: { occurredAt: { $dateOn: '2028' } } })).toEqual([]);
      });

      it('supports captured date descriptors in the existing single grouped reader', async () => {
        const group = { field: 'occurredAt', format: 'YYYY', timezone: '+08:00' };
        const resolve = resolver.getMockImplementation()!;
        resolver.mockImplementation((...args) => {
          group.field = 'name';
          group.timezone = '-05:00';
          group.format = 'YYYY-MM-DD';
          return resolve(...args);
        });
        expect(
          await reads.groupAggregate(ctx, mainIdentity, auth, {
            field: 'amount',
            method: 'sum',
            groupBy: [group],
            order: [{ by: 'field', field: 'occurredAt', direction: 'desc' }],
          }),
        ).toEqual([
          { key: { occurredAt: '2027' }, value: 60 },
          { key: { occurredAt: '2026' }, value: 10 },
          { key: { occurredAt: null }, value: 50 },
        ]);
      });

      it('rejects malformed internal date descriptors without running getters or SQL', async () => {
        const getter = vi.fn(() => 'YYYY');
        const valid = { field: 'occurredAt', format: 'YYYY', timezone: '+08:00' };
        const sql = vi.spyOn(db.sequelize, 'query');
        for (const groupBy of [
          [{ field: 'occurredAt', format: 'YYYY' }],
          [{ ...valid, format: 'YYYY-Q' }],
          [{ ...valid, timezone: 'UTC' }],
          [{ ...valid, extra: true }],
          [{ ...valid, field: 'labels' }],
          [valid, 'occurredAt'],
          [Object.defineProperty({ field: 'occurredAt', timezone: '+08:00' }, 'format', { get: getter })],
        ])
          await expect(
            reads.aggregateMany(ctx, mainIdentity, auth, { measures: [{ field: 'id', method: 'count' }], groupBy }),
          ).rejects.toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
      });

      it.each(['phase', 'type'])('rejects %s changes after the formatted query', async (change) => {
        const find = docs.model.findAll.bind(docs.model);
        vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (...args) => {
          const result = await find(...args);
          if (change === 'phase') adapter.release(ctx);
          else docs.model.rawAttributes.occurredAt.type = DataTypes.STRING;
          return result;
        });
        await expect(dateChart()).rejects.toThrow();
      });

      it('rejects non-date fields, unsupported formats and injected timezone before SQL', async () => {
        const getter = vi.fn(() => 'YYYY');
        const sql = vi.spyOn(db.sequelize, 'query');
        for (const dimensions of [
          [{ field: 'amount', format: 'YYYY', type: 'date' }],
          [{ field: 'name', format: 'YYYY-MM-DD', type: 'datetime' }],
          [{ field: 'occurredAt', format: 'YYYY-MM-DD hh:mm:ss' }],
          [{ field: 'occurredAt', format: 'YYYY', timezone: '+00:00' }],
          [Object.defineProperty({ field: 'occurredAt' }, 'format', { get: getter })],
        ])
          await expect(dateChart({ dimensions })).rejects.toThrow();
        for (const timezone of ['UTC', '+14:01', "'+08:00", '+08:00;select 1'])
          await expect(dateChart({}, timezone)).rejects.toThrow();
        await expect(chart({ dimensions: [{ field: 'occurredAt', format: 'YYYY' }] })).rejects.toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
      });
    });

    it('returns flat chart aliases under list permissions with independently authorized fields', async () => {
      entryResolver.mockImplementation((_collection, _path, operation) => ({
        allowed: operation.kind === 'list',
        params: { fields: ['amount', 'tenantId'] },
      }));
      expect(await chart()).toEqual([
        { 归属: 'B', 金额: 60 },
        { 归属: 'H', 金额: 20 },
        { 归属: null, 金额: 40 },
      ]);
      expect(entryResolver.mock.calls.every(([, , operation]) => operation.kind === 'list')).toBe(true);
      entryResolver.mockImplementation(() => ({ allowed: true, params: { fields: ['amount'] } }));
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(chart()).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
    });

    it.each([
      ['sum', 120],
      ['avg', 30],
      ['min', 10],
      ['max', 50],
      ['count', 4],
    ])('supports scalar %s with default field aliases and string fields', async (aggregation, amount) => {
      expect(await chart({ measures: [{ field: 'amount', aggregation }], dimensions: [] })).toEqual([{ amount }]);
    });

    it('treats aliases and type hints as output metadata without invoking object prototypes', async () => {
      const rows = await chart({
        measures: [{ field: 'amount', aggregation: 'sum', alias: '__proto__', type: 'string' }],
        dimensions: [{ field: 'tenantId', alias: 'constructor', type: 'integer', format: '' }],
      });
      expect(rows.map((row) => [row.constructor, row.__proto__])).toEqual([
        ['B', 60],
        ['H', 20],
        [null, 40],
      ]);
      expect(rows.every((row) => Object.getPrototypeOf(row) === Object.prototype)).toBe(true);
      expect(rows.every((row) => Object.hasOwn(row, '__proto__') && Object.isFrozen(row))).toBe(true);
    });

    it('preserves fractional averages and multiple mapped grouping fields', async () => {
      await docs.model.update({ amount: 51 }, { where: { id: 5 } });
      expect(await chart({ measures: [{ field: ['amount'], aggregation: 'avg' }], filter: { tenantId: 'B' } })).toEqual(
        [{ 归属: 'B', amount: 30.5 }],
      );
      expect(await chart({ dimensions: [{ field: 'tenantId' }, { field: ['projectId'], alias: '项目' }] })).toEqual([
        { tenantId: 'B', 项目: 101, 金额: 10 },
        { tenantId: 'B', 项目: null, 金额: 51 },
        { tenantId: 'H', 项目: 102, 金额: 20 },
        { tenantId: null, 项目: 103, 金额: 40 },
      ]);
    });

    it('intersects role and request filters and preserves empty scalar and grouped results', async () => {
      permissions.set('', {
        allowed: true,
        params: { fields: ['tenantId', 'amount'], filter: { amount: { $gte: 20 } } },
      });
      expect(await chart({ filter: { amount: { $lte: 40 } } })).toEqual([
        { 归属: 'H', 金额: 20 },
        { 归属: null, 金额: 40 },
      ]);
      expect(await chart({ filter: { amount: 30 } })).toEqual([]);
      expect(await chart({ dimensions: [], filter: { amount: 30 } })).toEqual([{ 金额: null }]);
      expect(
        await chart({ dimensions: [], filter: { amount: 30 }, measures: [{ field: 'amount', aggregation: 'count' }] }),
      ).toEqual([{ amount: 0 }]);
    });

    it('denies missing list permission and cannot use aliases or type hints to grant fields', async () => {
      permissions.set('', { allowed: false, params: {} });
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(chart()).rejects.toThrow(/authorized/);
      permissions.set('', { allowed: true, params: { fields: ['amount', 'tenantId'] } });
      await expect(
        chart({ measures: [{ field: 'name', aggregation: 'count', alias: 'amount', type: 'integer' }] }),
      ).rejects.toThrow(/authorized/);
      await expect(chart({ measures: [{ field: 'tenantId', aggregation: 'sum', type: 'integer' }] })).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    });

    it('independently restricts actual relationship filters while preserving hidden role facts', async () => {
      permissions.set('', {
        allowed: true,
        params: { fields: ['tenantId', 'amount'], appends: [], filter: { project: { name: 'Secret' } } },
      });
      expect(await chart()).toEqual([{ 归属: 'H', 金额: 20 }]);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(chart({ filter: { project: { name: 'Secret' } } })).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
      permissions.set('', { allowed: true, params: {} });
      expect(await chart({ filter: { project: { name: 'Secret' } } })).toEqual([]);
      expect(await chart({ filter: { project: { name: 'Zebra' } } })).toEqual([{ 归属: 'B', 金额: 10 }]);
    });

    it('uses trusted date shortcuts without granting client control of the date context', async () => {
      await docs.model.update({ occurredAt: new Date('2026-09-16T08:00:00Z') }, { where: { id: [1, 2, 3] } });
      const dates = { now: '2026-09-16T12:00:00.000Z', timezone: '+08:00' };
      expect(
        await entryReads.chartFromParams(
          ctx,
          mainIdentity,
          auth,
          {
            measures: [{ field: 'amount', aggregation: 'sum', alias: '金额' }],
            filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } },
          },
          undefined,
          dates,
        ),
      ).toEqual([{ 金额: 30 }]);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(chart({ dates })).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    });

    it('captures aliases groups and filters before permission callbacks and asynchronous SQL', async () => {
      const params = {
        measures: [{ field: ['amount'], aggregation: 'sum', alias: '金额' }],
        dimensions: [{ field: ['tenantId'], alias: '归属' }],
        filter: { amount: { $gte: 20 } },
      };
      entryResolver.mockImplementation(() => {
        params.measures[0].field[0] = 'name';
        params.measures[0].alias = 'changed';
        params.dimensions[0].field[0] = 'name';
        params.dimensions[0].alias = 'changed';
        params.filter.amount.$gte = 100;
        return { allowed: true, params: {} };
      });
      const pending = entryReads.chartFromParams(ctx, mainIdentity, auth, params);
      params.measures.length = 0;
      expect(await pending).toEqual([
        { 归属: 'B', 金额: 50 },
        { 归属: 'H', 金额: 20 },
        { 归属: null, 金额: 40 },
      ]);
    });

    it('preserves trusted transactions and keeps visible legacy data unclaimed', async () => {
      const transaction = await db.sequelize.transaction();
      try {
        await docs.model.update({ amount: 99 }, { where: { id: 1 }, transaction });
        expect(
          await entryReads.chartFromParams(
            ctx,
            mainIdentity,
            auth,
            { measures: [{ field: 'amount', aggregation: 'sum' }] },
            transaction,
          ),
        ).toEqual([{ amount: 209 }]);
        expect((await docs.model.findByPk(4, { transaction }))!.getDataValue('tenantId')).toBeNull();
      } finally {
        await transaction.rollback();
      }
      expect(await chart({ dimensions: [] })).toEqual([{ 金额: 120 }]);
    });

    it('enforces the group cap without returning truncated chart data', async () => {
      await expect(chart({ limit: 2 })).rejects.toThrow(/limit/);
      expect(await chart({ limit: 1, filter: { tenantId: 'B' } })).toEqual([{ 归属: 'B', 金额: 60 }]);
    });

    it.each(['sum', 'avg', 'min', 'max', 'count'])(
      'orders authorized %s values in SQL with NULL last',
      async (aggregation) => {
        await docs.model.update({ amount: null }, { where: { id: 4 } });
        const rows = await chart({
          measures: [{ field: 'amount', aggregation, alias: '金额' }],
          orders: [{ field: ['金额'], order: 'desc' }],
        });
        expect(rows.map((row) => row.归属)).toEqual(aggregation === 'min' ? ['H', 'B', null] : ['B', 'H', null]);
        const ascending = await chart({
          measures: [{ field: 'amount', aggregation, alias: '金额' }],
          orders: [{ field: 'amount', alias: '金额', order: 'ASC' }],
        });
        expect(ascending.map((row) => row.归属)).toEqual(
          aggregation === 'count' ? [null, 'H', 'B'] : aggregation === 'min' ? ['B', 'H', null] : ['H', 'B', null],
        );
      },
    );

    it('orders selected dimensions with stable remaining group keys and default ascending direction', async () => {
      expect((await chart({ orders: [{ field: ['归属'], order: 'DESC' }] })).map((row) => row.归属)).toEqual([
        'H',
        'B',
        null,
      ]);
      expect((await chart({ orders: [{ alias: '金额' }] })).map((row) => row.归属)).toEqual(['H', null, 'B']);
      await docs.model.update({ amount: 20 }, { where: { id: [1, 4, 5] } });
      expect((await chart({ orders: [{ field: '金额', order: 'asc' }] })).map((row) => row.归属)).toEqual([
        'H',
        null,
        'B',
      ]);
      expect(
        await chart({
          dimensions: [{ field: 'tenantId' }, { field: 'projectId' }],
          orders: [
            { field: '金额', order: 'desc' },
            { field: 'tenantId', order: 'desc' },
          ],
        }),
      ).toEqual([
        { tenantId: 'H', projectId: 102, 金额: 20 },
        { tenantId: 'B', projectId: 101, 金额: 20 },
        { tenantId: 'B', projectId: null, 金额: 20 },
        { tenantId: null, projectId: 103, 金额: 20 },
      ]);
    });

    it('keeps aliases out of SQL and validates scalar orders without changing the scalar result', async () => {
      const alias = '金额"; DROP TABLE documents; --';
      const sql = vi.spyOn(db.sequelize, 'query');
      expect(
        (
          await chart({
            measures: [{ field: 'amount', aggregation: 'sum', alias }],
            orders: [{ field: alias, order: 'desc' }],
          })
        ).map((row) => row.归属),
      ).toEqual(['B', null, 'H']);
      expect(sql.mock.calls.every(([query]) => !String(query).includes(alias))).toBe(true);
      expect(await chart({ dimensions: [], orders: [{ field: '金额', order: 'desc' }] })).toEqual([{ 金额: 120 }]);
    });

    it('accepts the full four-order bound and disambiguates a shared input field by explicit alias', async () => {
      expect(
        (
          await chart({
            dimensions: [{ field: 'tenantId' }, { field: 'projectId' }, { field: 'enabled' }],
            orders: [
              { field: '金额', order: 'desc' },
              { field: 'tenantId' },
              { field: 'projectId' },
              { field: 'enabled', order: 'desc' },
            ],
          })
        ).map((row) => row.金额),
      ).toEqual([50, 40, 20, 10]);
      expect(
        (
          await chart({
            dimensions: [{ field: 'amount', alias: '分组金额' }],
            orders: [{ field: 'amount', alias: '金额', order: 'desc' }],
          })
        ).map((row) => row.分组金额),
      ).toEqual([50, 40, 20, 10]);
    });

    it('captures chart order before permission callbacks and preserves role filters and caps', async () => {
      const params = {
        measures: [{ field: 'amount', aggregation: 'sum', alias: '金额' }],
        dimensions: [{ field: 'tenantId', alias: '归属' }],
        orders: [{ field: ['金额'], order: 'desc' }],
      };
      entryResolver.mockImplementationOnce(() => {
        params.orders[0].field[0] = 'name';
        params.orders[0].order = 'asc';
        return { allowed: true, params: { fields: ['amount', 'tenantId'], filter: { amount: { $gte: 20 } } } };
      });
      const pending = entryReads.chartFromParams(ctx, mainIdentity, auth, params);
      params.orders.length = 0;
      expect(await pending).toEqual([
        { 归属: 'B', 金额: 50 },
        { 归属: null, 金额: 40 },
        { 归属: 'H', 金额: 20 },
      ]);
      await expect(chart({ orders: [{ field: '金额', order: 'desc' }], limit: 2 })).rejects.toThrow(/limit/);
      const sql = vi.spyOn(db.sequelize, 'query');
      entryResolver.mockImplementation(() => ({ allowed: true, params: { fields: ['amount'] } }));
      await expect(chart({ orders: [{ field: '归属' }] })).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
    });

    it('rejects unknown ambiguous malformed or contradictory chart orders before SQL', async () => {
      const getter = vi.fn(() => '金额');
      const accessor = Object.defineProperty({}, 'field', { get: getter });
      const arrayAccessor = Object.defineProperty(['金额'], 0, { get: getter });
      const sparse: unknown[] = [];
      sparse.length = 1;
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const orders of [
        '金额',
        sparse,
        [accessor],
        [{ field: arrayAccessor }],
        [{ field: sparse }],
        [{ field: 'name' }],
        [{ field: ['project', 'name'] }],
        [{ field: 'project.name' }],
        [{ field: '金额', order: 'desc NULLS FIRST' }],
        [{ field: '金额', order: null }],
        [{ field: '金额', alias: '归属' }],
        [{ alias: 'missing' }],
        [{}],
        [{ field: '金额', extra: true }],
        [{ field: '金额' }, { alias: '金额' }],
        Array.from({ length: 5 }, () => ({ field: '金额' })),
      ])
        await expect(chart({ orders })).rejects.toThrow();
      await expect(
        chart({
          measures: [{ field: 'amount', aggregation: 'sum', alias: 'tenantId' }],
          dimensions: [{ field: 'tenantId', alias: '归属' }],
          orders: [{ field: 'tenantId' }],
        }),
      ).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
    });

    describe('multiple measures', () => {
      const measures = [
        { field: 'amount', aggregation: 'sum', alias: '合计' },
        { field: 'id', aggregation: 'count', alias: '数量' },
        { field: 'amount', aggregation: 'avg', alias: '平均' },
        { field: 'amount', aggregation: 'min', alias: '最小' },
        { field: 'amount', aggregation: 'max', alias: '最大' },
      ];

      it('computes every scalar statistic in one query over the same authorized roots', async () => {
        const find = vi.spyOn(docs.model, 'findAll');
        const scalar = vi.spyOn(docs.model, 'aggregate');
        expect(await chart({ measures, dimensions: [] })).toEqual([
          { 合计: 120, 数量: 4, 平均: 30, 最小: 10, 最大: 50 },
        ]);
        expect(find).toHaveBeenCalledTimes(1);
        expect(scalar).not.toHaveBeenCalled();
        expect(entryResolver.mock.calls.every(([, , operation]) => operation.kind === 'list')).toBe(true);
      });

      it('groups all measures in one SQL query and sorts the selected statistic independently', async () => {
        const find = vi.spyOn(docs.model, 'findAll');
        expect(await chart({ measures, orders: [{ field: '平均', order: 'desc' }] })).toEqual([
          { 归属: null, 合计: 40, 数量: 1, 平均: 40, 最小: 40, 最大: 40 },
          { 归属: 'B', 合计: 60, 数量: 2, 平均: 30, 最小: 10, 最大: 50 },
          { 归属: 'H', 合计: 20, 数量: 1, 平均: 20, 最小: 20, 最大: 20 },
        ]);
        expect(find).toHaveBeenCalledTimes(1);
        expect(await chart({ measures, orders: [{ field: 'id', alias: '数量', order: 'desc' }] })).toHaveLength(3);
        await expect(chart({ measures, orders: [{ field: 'amount' }] })).rejects.toThrow(/identify/);
      });

      it('preserves fractional averages NULL counts and empty scalar or grouped results', async () => {
        await docs.model.update({ amount: 51 }, { where: { id: 5 } });
        await docs.model.update({ amount: null }, { where: { id: 4 } });
        expect(await chart({ measures, filter: { tenantId: 'B' } })).toEqual([
          { 归属: 'B', 合计: 61, 数量: 2, 平均: 30.5, 最小: 10, 最大: 51 },
        ]);
        expect(await chart({ measures, filter: { id: 4 } })).toEqual([
          { 归属: null, 合计: null, 数量: 1, 平均: null, 最小: null, 最大: null },
        ]);
        const counts = [{ field: 'amount', aggregation: 'count', alias: '非空' }, ...measures];
        expect(await chart({ measures: counts, dimensions: [], filter: { id: 4 } })).toEqual([
          { 非空: 0, 合计: null, 数量: 1, 平均: null, 最小: null, 最大: null },
        ]);
        expect(await chart({ measures: counts, dimensions: [], filter: { id: 3 } })).toEqual([
          { 非空: 0, 合计: null, 数量: 0, 平均: null, 最小: null, 最大: null },
        ]);
        expect(await chart({ measures, filter: { id: 3 } })).toEqual([]);
      });

      it('requires permission for every measure and never runs partially authorized SQL', async () => {
        permissions.set('', { allowed: true, params: { fields: ['tenantId', 'amount'] } });
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(chart({ measures })).rejects.toThrow(/authorized/);
        await expect(
          chart({ measures: [measures[0], { field: 'name', aggregation: 'sum', alias: '无效' }] }),
        ).rejects.toThrow();
        expect(sql).not.toHaveBeenCalled();
        permissions.set('', {
          allowed: true,
          params: { fields: ['tenantId', 'amount', 'id'], filter: { amount: { $gte: 20 } } },
        });
        expect(await chart({ measures, dimensions: [], filter: { amount: { $lte: 40 } } })).toEqual([
          { 合计: 60, 数量: 2, 平均: 30, 最小: 20, 最大: 40 },
        ]);
      });

      it('keeps actual relationship visibility separate from hidden role facts', async () => {
        permissions.set('', {
          allowed: true,
          params: { fields: ['amount', 'id'], appends: [], filter: { project: { name: 'Secret' } } },
        });
        expect(await chart({ measures, dimensions: [] })).toEqual([
          { 合计: 20, 数量: 1, 平均: 20, 最小: 20, 最大: 20 },
        ]);
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(chart({ measures, dimensions: [], filter: { project: { name: 'Secret' } } })).rejects.toThrow(
          /authorized/,
        );
        expect(sql).not.toHaveBeenCalled();
        permissions.set('', { allowed: true, params: {} });
        expect(await chart({ measures, dimensions: [], filter: { project: { name: 'Secret' } } })).toEqual([
          { 合计: null, 数量: 0, 平均: null, 最小: null, 最大: null },
        ]);
      });

      it('captures all measures aliases filters and order before permission callbacks', async () => {
        const params = {
          measures: measures.map((measure) => ({ ...measure })),
          dimensions: [{ field: 'tenantId', alias: '归属' }],
          orders: [{ field: '平均', order: 'desc' }],
          filter: { amount: { $gte: 20 } },
        };
        entryResolver.mockImplementationOnce(() => {
          params.measures[1].field = 'name';
          params.measures[1].alias = 'changed';
          params.orders[0].field = '归属';
          params.orders[0].order = 'asc';
          params.filter.amount.$gte = 100;
          return { allowed: true, params: {} };
        });
        const pending = entryReads.chartFromParams(ctx, mainIdentity, auth, params);
        params.measures.length = 0;
        expect(await pending).toEqual([
          { 归属: 'B', 合计: 50, 数量: 1, 平均: 50, 最小: 50, 最大: 50 },
          { 归属: null, 合计: 40, 数量: 1, 平均: 40, 最小: 40, 最大: 40 },
          { 归属: 'H', 合计: 20, 数量: 1, 平均: 20, 最小: 20, 最大: 20 },
        ]);
      });

      it('propagates trusted transaction and dates while leaving legacy ownership unchanged', async () => {
        const transaction = await db.sequelize.transaction();
        try {
          await docs.model.update(
            { amount: 99, occurredAt: new Date('2026-09-16T08:00:00Z') },
            { where: { id: 1 }, transaction },
          );
          expect(
            await entryReads.chartFromParams(
              ctx,
              mainIdentity,
              auth,
              {
                measures,
                dimensions: [],
                filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } },
              },
              transaction,
              { now: '2026-09-16T12:00:00.000Z', timezone: '+08:00' },
            ),
          ).toEqual([{ 合计: 99, 数量: 1, 平均: 99, 最小: 99, 最大: 99 }]);
          expect((await docs.model.findByPk(4, { transaction }))!.getDataValue('tenantId')).toBeNull();
        } finally {
          await transaction.rollback();
        }
        expect(await chart({ measures, dimensions: [] })).toEqual([
          { 合计: 120, 数量: 4, 平均: 30, 最小: 10, 最大: 50 },
        ]);
      });

      it('allows ten measures and thirteen explicit sort targets but still rejects group overflow', async () => {
        const many = Array.from({ length: 10 }, (_, index) => ({
          field: 'amount',
          aggregation: 'sum',
          alias: `统计${index}`,
        }));
        expect((await chart({ measures: many, dimensions: [] }))[0]).toEqual(
          Object.fromEntries(many.map(({ alias }) => [alias, 120])),
        );
        expect(
          await chart({
            measures: many,
            dimensions: [{ field: 'tenantId' }, { field: 'projectId' }, { field: 'enabled' }],
            orders: [
              ...many.map(({ alias }) => ({ alias, order: 'desc' })),
              ...['tenantId', 'projectId', 'enabled'].map((field) => ({ field })),
            ],
          }),
        ).toHaveLength(4);
        await expect(chart({ measures, limit: 2 })).rejects.toThrow(/limit/);
      });

      it('keeps special aliases out of SQL and rejects duplicate or excess measures before SQL', async () => {
        const special = [
          { field: 'amount', aggregation: 'sum', alias: '__proto__' },
          { field: 'name', aggregation: 'count', alias: 'constructor' },
        ];
        const row = (await chart({ measures: special, dimensions: [] }))[0];
        expect(row.__proto__).toBe(120);
        expect(row.constructor).toBe(4);
        expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
        expect(Object.isFrozen(row)).toBe(true);
        const getter = vi.fn(() => 'amount');
        const sql = vi.spyOn(db.sequelize, 'query');
        for (const extra of [
          { measures: [...measures, { field: 'id', aggregation: 'count', alias: '合计' }] },
          { measures: [...measures, { field: 'id', aggregation: 'count', alias: '归属' }] },
          { measures: Array.from({ length: 11 }, (_, index) => ({ ...measures[0], alias: String(index) })) },
          { measures: [measures[0], Object.defineProperty({ aggregation: 'count' }, 'field', { get: getter })] },
          {
            measures,
            orders: [
              { alias: '平均', order: 'desc' },
              { field: 'amount', alias: '平均' },
            ],
          },
        ])
          await expect(chart(extra)).rejects.toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
      });

      it('rejects lifecycle changes after the multi-measure query', async () => {
        const original = docs.model.findAll.bind(docs.model);
        vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          adapter.release(ctx);
          return result;
        });
        await expect(chart({ measures })).rejects.toThrow();
      });
    });

    it('rejects unsupported chart protocols and malformed descriptors before any SQL', async () => {
      const getter = vi.fn(() => 'amount');
      const measure = Object.defineProperty({ aggregation: 'sum' }, 'field', { get: getter });
      const fields = Object.defineProperty(['amount'], 0, { get: getter });
      const sparse: unknown[] = [];
      sparse.length = 1;
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const extra of [
        { measures: [] },
        {
          measures: [
            { field: 'amount', aggregation: 'sum' },
            { field: 'id', aggregation: 'median' },
          ],
        },
        { measures: [{ field: 'amount' }] },
        { measures: [{ field: 'amount', aggregation: 'median' }] },
        { measures: [{ field: ['project', 'amount'], aggregation: 'sum' }] },
        { measures: [{ field: 'project.amount', aggregation: 'sum' }] },
        { measures: [{ field: 'amount', aggregation: 'sum', distinct: true }] },
        { measures: [measure] },
        { measures: sparse },
        { measures: [{ field: fields, aggregation: 'sum' }] },
        { measures: [{ field: [], aggregation: 'sum' }] },
        { dimensions: sparse },
        { dimensions: [{ field: 'id' }, { field: 'name' }, { field: 'tenantId' }, { field: 'enabled' }] },
        { dimensions: [{ field: 'name', alias: '金额' }] },
        { dimensions: [{ field: 'name' }, { field: 'name', alias: 'another' }] },
        { dimensions: [{ field: 'occurredAt', format: 'YYYY-MM' }] },
        { dimensions: [{ field: 'name', alias: '' }] },
        { dimensions: [{ field: 'name', alias: '\0' }] },
        { dimensions: [{ field: 'name', alias: 'a'.repeat(256) }] },
        { orders: [{ field: 'missing', order: 'desc' }] },
        { sql: { fields: '*' } },
        { transaction: {} },
        { collection: 'projects' },
        { dataSource: 'other' },
        { cache: { enabled: true } },
        { limit: 0 },
        { limit: 1001 },
      ])
        await expect(chart(extra)).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
    });
  });

  describe('chart query', () => {
    const values = () => ({
      uid: 'chart-test',
      dataSource: 'main',
      collection: 'documents',
      measures: [{ field: ['amount'], aggregation: 'sum', alias: '金额' }],
      dimensions: [{ field: ['tenantId'], alias: '归属' }],
      orders: [],
      cache: { enabled: true, ttl: 30 },
      refresh: false,
    });
    const chartQuery = (extra: Record<string, unknown> = {}) =>
      entryReads.chartFromQuery(ctx, auth, { ...values(), ...extra });

    const coreChart = async (acl: ACL, extra: Record<string, unknown> = {}) => {
      const context = Object.assign(ctx, {
        state: { currentRole: 'reader', currentUser: { id: 28, projectName: 'Secret' }, currentTenant: { id: 'B' } },
        action: {
          resourceName: 'documents',
          actionName: 'list',
          params: { fields: ['name'], filter: {} },
          mergeParams: vi.fn(),
        },
        get: () => '+08:00',
        logger: { info: vi.fn() },
        db,
        throw: (status: number) => {
          throw new Error(String(status));
        },
        permission: undefined as unknown,
      });
      let result: unknown;
      await acl.middleware()(context as never, async () => {
        permissions.set(
          '',
          captureFinalReadPermission(context.permission, {
            resourceName: 'documents',
            actionName: 'list',
            roleName: 'reader',
          }),
        );
        result = await entryReads.chartFromQuery(
          ctx,
          { ...auth, userId: 28, roleName: 'reader' },
          {
            ...values(),
            dimensions: [],
            ...extra,
          },
        );
      });
      return result;
    };

    it('uses finalized core list ACL, fixed scopes and hidden role facts without exposing them', async () => {
      const acl = new ACL();
      acl.setAvailableAction('view', { aliases: ['list', 'get'] });
      acl.define({ role: 'reader' }).grantAction('documents:view', {
        fields: ['amount'],
        appends: [],
        filter: { 'project.name': '{{ ctx.state.currentUser.projectName }}' },
      });
      acl.addFixedParams('documents', 'list', () => ({ filter: { amount: { $gte: 15 } } }));
      permissions.set('project', { allowed: false, params: {} });
      expect(await coreChart(acl)).toEqual([{ 金额: 20 }]);
      expect(await coreChart(acl, { filter: { $or: [{ amount: 10 }, { amount: 20 }, { amount: 30 }] } })).toEqual([
        { 金额: 20 },
      ]);
      await expect(coreChart(acl, { dimensions: [{ field: 'name' }] })).rejects.toThrow(/authorized/);
      await expect(coreChart(acl, { filter: { project: { name: 'Secret' } } })).rejects.toThrow(/authorized/);
      expect(entryResolver.mock.calls.every(([, , operation]) => operation.kind === 'list')).toBe(true);
    });

    it('keeps G/V and fixed scopes when core explicitly grants skip authorization', async () => {
      const acl = new ACL();
      acl.define({ role: 'reader' });
      acl.allow('documents', 'list', () => true);
      acl.addFixedParams('documents', 'list', () => ({ filter: { amount: { $gte: 20 } } }));
      expect(await coreChart(acl)).toEqual([{ 金额: 110 }]);
    });

    it('does not query when the real core middleware denies the operation', async () => {
      const acl = new ACL();
      acl.define({ role: 'reader' });
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(coreChart(acl)).rejects.toThrow('403');
      expect(sql).not.toHaveBeenCalled();
      expect(entryResolver).not.toHaveBeenCalled();
    });

    it('accepts a complete chart envelope and applies current list permissions and G/V', async () => {
      permissions.set('', {
        allowed: true,
        params: { fields: ['amount', 'tenantId'], filter: { amount: { $gte: 20 } } },
      });
      expect(await chartQuery()).toEqual([
        { 归属: 'B', 金额: 50 },
        { 归属: 'H', 金额: 20 },
        { 归属: null, 金额: 40 },
      ]);
      expect(entryResolver.mock.calls.every(([, , operation]) => operation.kind === 'list')).toBe(true);
      expect(await chartQuery({ dataSource: undefined, dimensions: [], filter: { tenantId: 'B' } })).toEqual([
        { 金额: 50 },
      ]);
      expect(await chartQuery({ filter: { amount: 30 } })).toEqual([]);
    });

    it('requeries identical cache-enabled requests and checks changed permissions each time', async () => {
      const params = { ...values(), dimensions: [] };
      expect(await entryReads.chartFromQuery(ctx, auth, params)).toEqual([{ 金额: 120 }]);
      await docs.model.update({ amount: 11 }, { where: { id: 1 } });
      expect(await entryReads.chartFromQuery(ctx, auth, params)).toEqual([{ 金额: 121 }]);
      permissions.set('', { allowed: false, params: {} });
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(entryReads.chartFromQuery(ctx, auth, params)).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
    });

    it('keeps trusted dates and transaction with multiple measures', async () => {
      const transaction = await db.sequelize.transaction();
      try {
        await docs.model.update(
          { occurredAt: new Date('2026-09-15T16:00:00Z') },
          { where: { id: [1, 2, 3] }, transaction },
        );
        expect(
          await entryReads.chartFromQuery(
            ctx,
            auth,
            {
              ...values(),
              measures: [
                { field: 'amount', aggregation: 'sum' },
                { field: 'id', aggregation: 'count' },
              ],
              dimensions: [{ field: 'occurredAt', format: 'YYYY-MM-DD', alias: '日期' }],
              filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } },
            },
            transaction,
            { now: '2026-09-16T12:00:00.000Z', timezone: '+08:00' },
          ),
        ).toEqual([{ 日期: '2026-09-16', amount: 30, id: 2 }]);
        expect((await docs.model.findByPk(4, { transaction }))!.getDataValue('tenantId')).toBeNull();
      } finally {
        await transaction.rollback();
      }
    });

    it('captures all client parameters, identity and dates before metadata callbacks', async () => {
      await docs.model.update({ occurredAt: new Date('2026-09-15T16:00:00Z') }, { where: { id: [1, 2, 3] } });
      const params = { ...values(), dimensions: [{ field: ['occurredAt'], alias: '日期', format: 'YYYY-MM-DD' }] };
      const dates = { now: '2026-09-16T12:00:00.000Z', timezone: '+08:00' };
      const identity = { tenantId: 'B' };
      const entry = new AccessEntryReadService(
        db,
        adapter,
        queries,
        (collection) => {
          params.collection = 'projects';
          params.dataSource = 'external';
          params.measures[0].field[0] = 'name';
          params.measures[0].alias = 'changed';
          params.dimensions[0].format = 'YYYY';
          dates.timezone = '-05:00';
          identity.tenantId = 'C';
          return identities.find((item) => item.collectionName === collection.name);
        },
        entryResolver,
      );
      expect(await entry.chartFromQuery(ctx, identity, params, undefined, dates)).toEqual([
        { 日期: '2026-09-16', 金额: 30 },
        { 日期: null, 金额: 90 },
      ]);
    });

    it('rejects data source or root collection mismatches without SQL or permission callbacks', async () => {
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const extra of [
        { dataSource: 'external' },
        { dataSource: '' },
        { collection: 'missing' },
        { collection: 'documents.project' },
        { collection: '_' },
      ])
        await expect(chartQuery(extra)).rejects.toThrow();
      const entry = new AccessEntryReadService(
        db,
        adapter,
        queries,
        () => ({ ...mainIdentity, collectionName: 'projects' }),
        entryResolver,
      );
      await expect(entry.chartFromQuery(ctx, auth, values())).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
      expect(entryResolver).not.toHaveBeenCalled();
    });

    it('does not fall back to main for an equally named external source', async () => {
      const entry = new AccessEntryReadService(
        db,
        adapter,
        queries,
        (collection) => {
          const identity = identities.find((item) => item.collectionName === collection.name);
          return identity && { ...identity, dataSourceKey: 'external' };
        },
        entryResolver,
      );
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(entry.chartFromQuery(ctx, auth, values())).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    });

    it('rejects persistent identity changes after execution', async () => {
      const identity = { ...mainIdentity };
      const entry = new AccessEntryReadService(
        db,
        adapter,
        queries,
        (collection) => (collection === docs ? identity : projectIdentity),
        entryResolver,
      );
      const find = docs.model.findAll.bind(docs.model);
      vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (...args) => {
        const rows = await find(...args);
        identity.collectionKey = 'recreated';
        return rows;
      });
      await expect(entry.chartFromQuery(ctx, auth, values())).rejects.toThrow();
    });

    it('rejects malformed metadata, identity injection and getters before resolving permissions or SQL', async () => {
      const getter = vi.fn(() => 'documents');
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const extra of [
        { uid: 'a'.repeat(256) },
        { uid: null },
        { refresh: 'true' },
        { cache: null },
        { cache: { enabled: 1 } },
        { cache: { enabled: true, ttl: -1 } },
        { cache: { ttl: Infinity } },
        { cache: { enabled: true, ttl: Number.MAX_SAFE_INTEGER } },
        { cache: { scope: 'shared' } },
        { tenantId: 'C' },
        { roleName: 'root' },
        { transaction: {} },
        { sql: { fields: '*' } },
        { dates: { now: '2026-01-01T00:00:00.000Z', timezone: '+00:00' } },
        { raw: true },
        Object.defineProperty({}, 'collection', { enumerable: true, get: getter }),
      ]) {
        // Preserve descriptors, including non-data properties, rather than invoking getters through object spread.
        const params = Object.defineProperties(values(), Object.getOwnPropertyDescriptors(extra));
        await expect(entryReads.chartFromQuery(ctx, auth, params)).rejects.toThrow();
      }
      expect(getter).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
      expect(entryResolver).not.toHaveBeenCalled();
    });
  });

  describe('multiple aggregate', () => {
    const batch = (extra: Record<string, unknown> = {}) =>
      reads.aggregateMany(ctx, mainIdentity, auth, {
        measures: [
          { field: 'amount', method: 'sum' },
          { field: 'amount', method: 'count' },
        ],
        ...extra,
      });

    it('computes distinct measures independently while sharing authorized groups', async () => {
      await docs.model.update({ amount: 10 }, { where: { id: 5 } });
      const result = await batch({
        measures: [
          { field: 'amount', method: 'sum' },
          { field: 'amount', method: 'sum', distinct: true },
          { field: 'name', method: 'count', distinct: true },
        ],
        groupBy: ['tenantId'],
        order: [{ by: 'value', index: 1, direction: 'desc' }],
      });
      expect(result).toEqual([
        { key: { tenantId: null }, values: [40, 40, 1] },
        { key: { tenantId: 'H' }, values: [20, 20, 1] },
        { key: { tenantId: 'B' }, values: [20, 10, 2] },
      ]);
      expect(Object.isFrozen(result[0].values)).toBe(true);
      expect(Object.isFrozen(result[0].key)).toBe(true);
    });

    it('snapshots measure groups order and limit before resolving field permissions', async () => {
      const request = {
        measures: [
          { field: 'amount', method: 'sum' },
          { field: 'amount', method: 'count' },
        ],
        groupBy: ['tenantId'],
        order: [{ by: 'value', index: 0, direction: 'desc' }],
        limit: 3,
      };
      const original = resolver.getMockImplementation()!;
      resolver.mockImplementationOnce((...args) => {
        request.measures[0].field = 'name';
        request.measures[1].method = 'min';
        request.groupBy[0] = 'name';
        request.order[0].index = 1;
        request.order[0].direction = 'asc';
        request.limit = 1;
        return original(...args);
      });
      expect(await reads.aggregateMany(ctx, mainIdentity, auth, request)).toEqual([
        { key: { tenantId: 'B' }, values: [60, 2] },
        { key: { tenantId: null }, values: [40, 1] },
        { key: { tenantId: 'H' }, values: [20, 1] },
      ]);
    });

    it('rejects malformed measure arrays descriptors and out-of-range ordering before SQL', async () => {
      const getter = vi.fn(() => 'amount');
      const sparse: unknown[] = [];
      sparse.length = 1;
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const extra of [
        { measures: [] },
        { measures: sparse },
        { measures: Object.defineProperty([{}], 0, { get: getter }) },
        { measures: [Object.defineProperty({ method: 'sum' }, 'field', { get: getter })] },
        { measures: [{ field: 'amount' }] },
        { measures: [{ method: 'sum' }] },
        { measures: [{ field: 'amount', method: 'SUM' }] },
        { measures: [{ field: 'amount', method: 'sum', alias: 'x' }] },
        { measures: [{ field: 'amount', method: 'sum', distinct: 1 }] },
        { measures: [{ field: 'labels', method: 'count', distinct: true }] },
        { measures: [{ field: 'missing', method: 'sum' }] },
        { measures: Array.from({ length: 11 }, () => ({ field: 'amount', method: 'sum' })) },
        { groupBy: ['labels'] },
        { groupBy: sparse },
        { order: [{ by: 'value', index: -1, direction: 'desc' }] },
        { order: [{ by: 'value', index: 2, direction: 'desc' }] },
        { order: [{ by: 'value', index: '1', direction: 'desc' }] },
        { order: [{ by: 'value', index: 0.5, direction: 'desc' }] },
        { order: [{ by: 'field', field: 'tenantId', index: 0, direction: 'desc' }], groupBy: ['tenantId'] },
        {
          order: [
            { by: 'value', direction: 'desc' },
            { by: 'value', index: 0, direction: 'asc' },
          ],
        },
        { having: {} },
        { field: 'amount' },
        { method: 'sum' },
        { limit: 1001 },
      ])
        await expect(batch(extra)).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
    });
  });

  describe('grouped aggregate', () => {
    const grouped = (extra: Record<string, unknown> = {}) =>
      entryReads.groupAggregate(ctx, mainIdentity, auth, {
        method: 'sum',
        field: 'amount',
        groupBy: ['tenantId'],
        ...extra,
      } as never);

    it('orders grouped values or mapped group fields with stable NULL-last ties', async () => {
      expect((await grouped({ order: [{ by: 'value', direction: 'desc' }] })).map((row) => row.key.tenantId)).toEqual([
        'B',
        null,
        'H',
      ]);
      expect(
        (await grouped({ order: [{ by: 'field', field: 'tenantId', direction: 'desc' }] })).map(
          (row) => row.key.tenantId,
        ),
      ).toEqual(['H', 'B', null]);
    });

    it('captures grouped ordering before permission callbacks and rejects unsupported descriptors', async () => {
      const request = {
        method: 'sum',
        field: 'amount',
        groupBy: ['tenantId'],
        order: [{ by: 'value', direction: 'desc' }],
      };
      entryResolver.mockImplementation(() => {
        request.order[0].direction = 'asc';
        return { allowed: true, params: {} };
      });
      expect(
        (await entryReads.groupAggregate(ctx, mainIdentity, auth, request)).map((row) => row.key.tenantId),
      ).toEqual(['B', null, 'H']);
      const getter = vi.fn(() => 'value');
      const sql = vi.spyOn(db.sequelize, 'query');
      const sparse: unknown[] = [];
      sparse.length = 1;
      for (const order of [
        'amount',
        sparse,
        [Object.defineProperty({}, 'by', { get: getter })],
        [{ by: 'value' }],
        [{ direction: 'desc' }],
        [{ by: 'field', direction: 'desc' }],
        [{ by: 'value', direction: 'DESC' }],
        [{ by: 'value', direction: 'desc', field: 'name' }],
        [{ by: 'field', field: 'name', direction: 'desc' }],
        [{ by: 'field', field: 'amount', direction: 'desc' }],
        [{ by: 'field', field: 'project.name', direction: 'desc' }],
        [
          { by: 'value', direction: 'desc' },
          { by: 'value', direction: 'asc' },
        ],
      ])
        await expect(grouped({ order })).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
    });

    it.each([
      ['sum', 60],
      ['avg', 30],
      ['min', 10],
      ['max', 50],
      ['count', 2],
    ])('computes %s per authorized group without hidden disabled or deleted records', async (method, value) => {
      expect(await grouped({ method })).toEqual([
        { key: { tenantId: 'B' }, value },
        { key: { tenantId: 'H' }, value: method === 'count' ? 1 : 20 },
        { key: { tenantId: null }, value: method === 'count' ? 1 : 40 },
      ]);
      expect(entryResolver.mock.calls.every(([, , operation]) => operation.kind === 'groupAggregate')).toBe(true);
    });

    it('intersects role rows and request filters before grouping', async () => {
      permissions.set('', {
        allowed: true,
        params: { fields: ['tenantId', 'amount'], filter: { amount: { $gte: 20 } } },
      });
      expect(await grouped({ filter: { amount: { $lte: 40 } } })).toEqual([
        { key: { tenantId: 'H' }, value: 20 },
        { key: { tenantId: null }, value: 40 },
      ]);
      expect(await grouped({ filter: { amount: 30 } })).toEqual([]);
    });

    it('groups by multiple mapped physical fields and preserves boolean and date values', async () => {
      expect(await grouped({ groupBy: ['tenantId', 'projectId'] })).toEqual([
        { key: { tenantId: 'B', projectId: 101 }, value: 10 },
        { key: { tenantId: 'B', projectId: null }, value: 50 },
        { key: { tenantId: 'H', projectId: 102 }, value: 20 },
        { key: { tenantId: null, projectId: 103 }, value: 40 },
      ]);
      await docs.model.update(
        { name: 'Grouped', occurredAt: new Date('2026-09-16T00:00:00Z') },
        { where: { id: [1, 5] } },
      );
      expect(await grouped({ groupBy: ['name'], filter: { tenantId: 'B' } })).toEqual([
        { key: { name: 'Grouped' }, value: 60 },
      ]);
      expect(await grouped({ groupBy: ['enabled'], filter: { tenantId: 'B' } })).toEqual([
        { key: { enabled: true }, value: 60 },
      ]);
      const dateResult = await grouped({ groupBy: ['occurredAt'], filter: { tenantId: 'B' } });
      expect(dateResult[0].key.occurredAt).toEqual(new Date('2026-09-16T00:00:00Z'));
      expect(dateResult[0].value).toBe(60);
    });

    it('keeps NULL group keys independent from nonnull counts and distinct field values', async () => {
      await docs.model.update({ amount: 10 }, { where: { id: 5 } });
      await docs.model.update({ amount: null }, { where: { id: 4 } });
      expect(await grouped({ method: 'count' })).toEqual([
        { key: { tenantId: 'B' }, value: 2 },
        { key: { tenantId: 'H' }, value: 1 },
        { key: { tenantId: null }, value: 0 },
      ]);
      expect(await grouped({ distinct: true })).toEqual([
        { key: { tenantId: 'B' }, value: 10 },
        { key: { tenantId: 'H' }, value: 20 },
        { key: { tenantId: null }, value: null },
      ]);
      expect(await grouped({ method: 'count', field: 'name', filter: { tenantId: 'B' } })).toEqual([
        { key: { tenantId: 'B' }, value: 2 },
      ]);
    });

    it('requires independent operation grouping and measure field permissions before SQL', async () => {
      entryResolver.mockImplementation((_collection, _path, operation) => ({
        allowed: operation.kind !== 'groupAggregate',
        params: {},
      }));
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(grouped()).rejects.toThrow(/authorized/);
      entryResolver.mockImplementation(() => ({ allowed: true, params: { fields: ['amount'] } }));
      await expect(grouped()).rejects.toThrow(/authorized/);
      entryResolver.mockImplementation(() => ({ allowed: true, params: { fields: ['tenantId'] } }));
      await expect(grouped()).rejects.toThrow(/authorized/);
      expect(query).not.toHaveBeenCalled();
    });

    it('uses hidden role facts internally but filters actual relationships by target read access', async () => {
      permissions.set('', {
        allowed: true,
        params: {
          fields: ['tenantId', 'amount'],
          appends: [],
          filter: { project: { name: 'Secret' } },
        },
      });
      expect(await grouped()).toEqual([{ key: { tenantId: 'H' }, value: 20 }]);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(grouped({ filter: { project: { name: 'Secret' } } })).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
      permissions.set('', { allowed: true, params: {} });
      expect(await grouped({ filter: { project: { name: 'Secret' } } })).toEqual([]);
      expect(await grouped({ filter: { project: { name: 'Zebra' } } })).toEqual([
        { key: { tenantId: 'B' }, value: 10 },
      ]);
    });

    it('rejects malformed groups options and accessors before SQL without invoking them', async () => {
      const getter = vi.fn(() => 'tenantId');
      const group = Object.defineProperty(['tenantId'], 0, { get: getter });
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const extra of [
        { groupBy: [] },
        { groupBy: ['tenantId', 'tenantId'] },
        { groupBy: ['id', 'name', 'amount', 'tenantId'] },
        { groupBy: ['project.name'] },
        { groupBy: ['labels'] },
        { groupBy: ['missing'] },
        { groupBy: group },
        { groupBy: 'tenantId' },
        { groupBy: [literal('1')] },
        { groupBy: ['tenantId; --'] },
        { method: 'median' },
        { method: 'sum', field: 'name' },
        { limit: 0 },
        { limit: 1001 },
        { having: {} },
        { sort: ['name'] },
        { bind: {} },
        { dataType: 'INTEGER' },
      ])
        await expect(grouped(extra)).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
    });

    it('bounds group output with a database limit and rejects overflow instead of truncating', async () => {
      const find = vi.spyOn(docs.model, 'findAll');
      await expect(grouped({ limit: 2 })).rejects.toThrow(/limit/);
      expect(find.mock.calls[0][0]!.limit).toBe(3);
      expect(await grouped({ limit: 1, filter: { tenantId: 'B' } })).toEqual([{ key: { tenantId: 'B' }, value: 60 }]);
    });

    it('snapshots group and filter input before the first asynchronous query', async () => {
      const request = { method: 'sum', field: 'amount', groupBy: ['tenantId'], filter: { amount: { $gte: 20 } } };
      const pending = entryReads.groupAggregate(ctx, mainIdentity, auth, request);
      request.groupBy[0] = 'name';
      request.filter.amount.$gte = 100;
      request.method = 'max';
      expect(await pending).toEqual([
        { key: { tenantId: 'B' }, value: 50 },
        { key: { tenantId: 'H' }, value: 20 },
        { key: { tenantId: null }, value: 40 },
      ]);
    });

    it('preserves trusted transactions and does not claim legacy ownership', async () => {
      const transaction = await db.sequelize.transaction();
      try {
        await docs.model.update({ amount: 99 }, { where: { id: 1 }, transaction });
        expect(await grouped({ transaction, filter: { tenantId: 'B' } })).toEqual([
          { key: { tenantId: 'B' }, value: 149 },
        ]);
        expect(await grouped({ transaction, filter: { id: 4 } })).toEqual([{ key: { tenantId: null }, value: 40 }]);
        expect((await docs.model.findByPk(4, { transaction }))!.getDataValue('tenantId')).toBeNull();
      } finally {
        await transaction.rollback();
      }
      await expect(grouped({ transaction })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    });

    it('rejects metadata or phase changes after the grouped SQL', async () => {
      const original = docs.model.findAll.bind(docs.model);
      const find = vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        docs.model.rawAttributes.tenantId.field = 'changed_column';
        return result;
      });
      await expect(grouped()).rejects.toThrow(/changed/);
      docs.model.rawAttributes.tenantId.field = 'tenant_id';
      find.mockRestore();
      vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        adapter.release(ctx);
        return result;
      });
      await expect(grouped()).rejects.toThrow();
    });

    it('keeps query counts constant when more roots belong to a group', async () => {
      const sql = vi.spyOn(db.sequelize, 'query');
      await grouped();
      const before = sql.mock.calls.length;
      await docs.model.bulkCreate(
        Array.from({ length: 20 }, (_, index) => ({ id: 200 + index, tenantId: 'B', name: 'Owned', amount: 1 })),
      );
      sql.mockClear();
      expect((await grouped())[0]).toEqual({ key: { tenantId: 'B' }, value: 80 });
      expect(sql.mock.calls.length).toBe(before);
      expect(before).toBeLessThanOrEqual(5);
    });
  });

  describe('numeric aggregate', () => {
    const aggregate = (request: Record<string, unknown>) =>
      entryReads.aggregate(ctx, mainIdentity, auth, request as never);

    it.each([
      ['avg', 30],
      ['min', 10],
      ['max', 50],
      ['sum', 120],
      ['count', 4],
    ] as const)('computes %s over the same scoped roots as the list', async (method, expected) => {
      expect(await aggregate({ method, field: 'amount' })).toBe(expected);
      permissions.set('', { allowed: true, params: { filter: { amount: { $gte: 20 } } } });
      expect(await aggregate({ method, field: 'amount', filter: { amount: { $lte: 40 } } })).toBe(
        method === 'avg' ? 30 : method === 'min' ? 20 : method === 'max' ? 40 : method === 'count' ? 2 : 60,
      );
    });
    it.each(['avg', 'min', 'max', 'sum', 'count'] as const)('preserves empty-set semantics for %s', async (method) => {
      expect(await aggregate({ method, field: 'amount', filter: { id: 3 } })).toBe(method === 'count' ? 0 : null);
    });
    it.each([
      ['avg', 2.5],
      ['min', 1.25],
      ['max', 3.75],
      ['sum', 7.5],
      ['count', 3],
    ] as const)('supports the built-in double field for %s including distinct', async (method, expected) => {
      docs.setField('stat', { type: 'double', field: 'stat_value' });
      await db.sequelize.getQueryInterface().addColumn('read_documents', 'stat_value', {
        type: docs.model.rawAttributes.stat.type,
      });
      for (const [id, stat] of [
        [1, 1.25],
        [2, 2.5],
        [3, 100],
        [5, 3.75],
      ])
        await docs.model.update({ stat }, { where: { id } });
      expect(await aggregate({ method, field: 'stat', distinct: true })).toBe(expected);
      if (method === 'sum') expect(await reads.sum(ctx, mainIdentity, auth, { field: 'stat' })).toBe(7.5);
    });
    it('counts authorized non-null values including strings and distinguishes distinct values from root count', async () => {
      await docs.model.update({ amount: 10 }, { where: { id: 2 } });
      expect(await aggregate({ method: 'count', field: 'projectId' })).toBe(3);
      expect(await aggregate({ method: 'count', field: 'name', distinct: true })).toBe(4);
      expect(await aggregate({ method: 'sum', field: 'amount', distinct: true })).toBe(100);
      expect(await aggregate({ method: 'avg', field: 'amount', distinct: true })).toBeCloseTo(100 / 3);
      expect(await aggregate({ method: 'count', field: 'amount', distinct: true })).toBe(3);
      expect(await aggregate({ method: 'sum', field: 'amount', distinct: false })).toBe(110);
      expect(await reads.count(ctx, mainIdentity, auth)).toBe(4);
    });
    it('uses independent aggregate action permission and enforces field grants before SQL', async () => {
      entryResolver.mockImplementation((_collection, _path, operation) =>
        operation.kind === 'aggregate' ? null : { allowed: true, params: {} },
      );
      expect(await entryReads.count(ctx, mainIdentity, auth)).toBe(4);
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(aggregate({ method: 'avg', field: 'amount' })).rejects.toThrow(/authorized/);
      entryResolver.mockImplementation(() => ({ allowed: true, params: { fields: ['name'] } }));
      await expect(aggregate({ method: 'count', field: 'amount' })).rejects.toThrow(/authorized/);
      expect(query).not.toHaveBeenCalled();
      expect(await aggregate({ method: 'count', field: 'name' })).toBe(4);
    });
    it('rejects JSON distinct before SQL while allowing non-null JSON value counts', async () => {
      await docs.model.update({ labels: { value: 1 } }, { where: { id: 1 } });
      expect(await aggregate({ method: 'count', field: 'labels' })).toBe(1);
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(aggregate({ method: 'count', field: 'labels', distinct: true })).rejects.toThrow(
        /distinct.*scalar/i,
      );
      expect(query).not.toHaveBeenCalled();
    });
    it('aggregates each root once when an actual relationship filter matches multiple children', async () => {
      docs.setField('matches', { type: 'hasMany', target: 'projects', foreignKey: 'projectId' });
      await projects.model.update({ projectId: 1 }, { where: { id: [101, 103] } });
      const filter = { matches: { name: { $ne: 'Missing' } } };
      expect(await aggregate({ method: 'count', field: 'amount', filter })).toBe(1);
      expect(await aggregate({ method: 'sum', field: 'amount', filter })).toBe(10);
    });
    it('uses mapped physical numeric fields without accepting physical column names as field names', async () => {
      expect(await aggregate({ method: 'sum', field: 'id' })).toBe(12);
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(aggregate({ method: 'sum', field: 'record_id' })).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    });
    it('uses visible target scopes for request filters but preserves hidden relationship facts for role filters', async () => {
      expect(await aggregate({ method: 'sum', field: 'amount', filter: { 'project.name': 'Secret' } })).toBeNull();
      permissions.set('', { allowed: true, params: { filter: { 'project.name': 'Secret' } } });
      permissions.set('project', null);
      expect(await aggregate({ method: 'max', field: 'amount' })).toBe(20);
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(aggregate({ method: 'max', field: 'amount', filter: { 'project.name': 'Secret' } })).rejects.toThrow(
        /authorized/,
      );
      expect(query).not.toHaveBeenCalled();
    });
    it('rejects unsupported methods, fields and query options before SQL or invoking getters', async () => {
      const getter = vi.fn(() => 'avg');
      const accessor = Object.defineProperty({ field: 'amount' }, 'method', { get: getter });
      const query = vi.spyOn(db.sequelize, 'query');
      for (const request of [
        accessor,
        { method: 'SUM(amount); --', field: 'amount' },
        { method: 'median', field: 'amount' },
        { method: 'avg' },
        { method: 'avg', field: 'name' },
        { method: 'count', field: 'project.name' },
        { method: 'sum', field: 'amount', distinct: 'true' },
        { method: 'sum', field: 'amount', distinct: null },
        { method: 'sum', field: 'amount', group: ['tenantId'] },
        { method: 'sum', field: 'amount', dataType: 'INTEGER' },
        { method: 'sum', field: 'amount', limit: 1 },
        { method: 'sum', field: literal('amount') },
        { method: 'sum', field: 'amount', transaction: {} },
      ])
        await expect(aggregate(request)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
    });
    it('captures request, identity and final permissions before asynchronous scope preparation', async () => {
      const request = { method: 'sum', field: 'amount', distinct: false, filter: { id: { $in: [1, 2] } } };
      const source = { ...mainIdentity };
      const authenticated = { ...auth };
      const permission = { allowed: true, params: { filter: { amount: { $lte: 20 } } } };
      permissions.set('', permission);
      const original = queries.scopeQuery.bind(queries);
      vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
        request.method = 'max';
        request.field = 'id';
        request.distinct = true;
        request.filter.id.$in = [3];
        source.collectionName = 'projects';
        authenticated.tenantId = 'C';
        permission.params.filter.amount.$lte = 0;
        return original(...args);
      });
      expect(await entryReads.aggregate(ctx, source, authenticated, request)).toBe(30);
    });
    it('checks prepared phase after the aggregate SQL', async () => {
      const original = docs.model.aggregate.bind(docs.model);
      vi.spyOn(docs.model, 'aggregate').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        adapter.release(ctx);
        return result;
      });
      await expect(aggregate({ method: 'avg', field: 'amount' })).rejects.toThrow();
    });
    it('rejects changed aggregation field metadata before returning results', async () => {
      const original = docs.model.aggregate.bind(docs.model);
      vi.spyOn(docs.model, 'aggregate').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        docs.model.rawAttributes.amount.field = 'changed_column';
        return result;
      });
      await expect(aggregate({ method: 'max', field: 'amount' })).rejects.toThrow(/changed/);
    });
    it('reads uncommitted scoped values in the supplied transaction and respects default scopes and soft deletes', async () => {
      const transaction = await db.sequelize.transaction();
      try {
        await docs.model.create({ id: 9, tenantId: 'B', amount: 90 }, { transaction });
        expect(await aggregate({ method: 'max', field: 'amount', transaction })).toBe(90);
        expect(await aggregate({ method: 'sum', field: 'amount', transaction })).toBe(210);
      } finally {
        await transaction.rollback();
      }
      expect(await aggregate({ method: 'max', field: 'amount' })).toBe(50);
      expect(await docs.model.findByPk(4)).toHaveProperty('tenantId', null);
    });
    it('keeps query counts bounded as matching root rows increase', async () => {
      const query = vi.spyOn(db.sequelize, 'query');
      const run = async () => {
        query.mockClear();
        await aggregate({ method: 'sum', field: 'amount', filter: { 'project.name': 'Zebra' } });
        return query.mock.calls.length;
      };
      const before = await run();
      await docs.model.bulkCreate(
        Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, tenantId: 'B', amount: 1, projectId: 101 })),
      );
      expect(await run()).toBe(before);
      expect(await aggregate({ method: 'count', field: 'amount', filter: { 'project.name': 'Zebra' } })).toBe(101);
    });
    it('supports an explicitly shared collection without tenant context or a physical tenant column', async () => {
      const key = (collection: Collection) =>
        accessCollectionKey(identities.find((i) => i.collectionName === collection.name)!);
      const store = new AccessConfigStore(db, (identity) =>
        resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: key }),
      );
      await store.save(
        projectIdentity,
        { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
        { userId: 28 },
      );
      await db.sequelize.getQueryInterface().removeColumn('read_projects', 'tenant_id');
      projects.removeField('tenantId');
      adapter.release(ctx);
      await adapter.prepare(ctx, identities);
      const query = vi.spyOn(db.sequelize, 'query');
      expect(await entryReads.aggregate(ctx, projectIdentity, {}, { method: 'count', field: 'name' })).toBe(3);
      expect(await entryReads.aggregate(ctx, projectIdentity, {}, { method: 'avg', field: 'amount' })).toBeNull();
      expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('tenant_id');
    });
  });
  describe('absolute date filtering', () => {
    beforeEach(async () => {
      for (const [id, date] of [
        [1, '2026-09-15T16:00:00.000Z'],
        [2, '2026-09-16T15:59:59.999Z'],
        [3, '2026-09-16T00:00:00.000Z'],
        [4, '2026-09-15T15:59:59.999Z'],
        [5, '2026-09-16T16:00:00.000Z'],
        [6, '2026-09-16T00:00:00.000Z'],
        [7, '2026-09-16T00:00:00.000Z'],
      ] as const)
        await docs.model.update({ occurredAt: new Date(date) }, { where: { id }, paranoid: false });
    });
    it('selects the local calendar day within role and tenant scopes', async () => {
      expect(
        await entryReads.listFromParams(ctx, mainIdentity, auth, {
          fields: ['name'],
          filter: { occurredAt: { $dateOn: '2026-09-16+08:00' } },
        }),
      ).toEqual([{ name: 'Owned' }, { name: 'Visible' }]);
    });
    it('resolves page date shortcuts from a trusted fixed clock', async () => {
      expect(
        await entryReads.listFromParams(
          ctx,
          mainIdentity,
          auth,
          {
            fields: ['name'],
            filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } },
          },
          undefined,
          { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' },
        ),
      ).toEqual([{ name: 'Owned' }, { name: 'Visible' }]);
    });
    describe('page date context', () => {
      const dates = { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' };
      const filter = { occurredAt: { $dateOn: '{{$nDate.today}}' } };
      it('summary params share list dates, role conditions and tenant scopes', async () => {
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter }, undefined, dates)).toBe(2);
        expect(
          await entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter }, undefined, dates),
        ).toBe(30);
        permissions.set('', { allowed: true, params: { filter: { amount: { $gte: 15 } } } });
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter }, undefined, dates)).toBe(1);
        expect(
          await entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter }, undefined, dates),
        ).toBe(20);
      });
      it('summary params preserve field GMT metadata and absolute date behavior without context', async () => {
        docs.getField('occurredAt').options.uiSchema = { 'x-component-props': { gmt: true } };
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter }, undefined, dates)).toBe(2);
        expect(
          await entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter }, undefined, dates),
        ).toBe(70);
        const absolute = { occurredAt: { $dateOn: '2026-09-16+08:00' } };
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter: absolute })).toBe(2);
        expect(await entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter: absolute })).toBe(30);
      });
      it('summary params independently constrain linked date targets and their role filters', async () => {
        await projects.model.update({ occurredAt: new Date(dates.now) }, { where: { id: [101, 102] } });
        const linked = { 'project.occurredAt': { $dateOn: '{{$date.today}}' } };
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter: linked }, undefined, dates)).toBe(1);
        expect(
          await entryReads.sumFromParams(
            ctx,
            mainIdentity,
            auth,
            { field: 'amount', filter: linked },
            undefined,
            dates,
          ),
        ).toBe(10);
        permissions.set('project', { allowed: true, params: { filter: { name: { $ne: 'Zebra' } } } });
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter: linked }, undefined, dates)).toBe(0);
        expect(
          await entryReads.sumFromParams(
            ctx,
            mainIdentity,
            auth,
            { field: 'amount', filter: linked },
            undefined,
            dates,
          ),
        ).toBeNull();
        permissions.set('project', null);
        const query = vi.spyOn(db.sequelize, 'query');
        await expect(
          entryReads.countFromParams(ctx, mainIdentity, auth, { filter: linked }, undefined, dates),
        ).rejects.toThrow(/authorized/);
        await expect(
          entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter: linked }, undefined, dates),
        ).rejects.toThrow(/authorized/);
        expect(query).not.toHaveBeenCalled();
      });
      it.each(['count', 'sum'] as const)(
        'summary params capture %s filter and dates before asynchronous scope queries',
        async (kind) => {
          const context = { ...dates };
          const params = {
            filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } },
            ...(kind === 'sum' ? { field: 'amount' } : {}),
          };
          const original = queries.scopeQuery.bind(queries);
          vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
            context.now = '2027-01-01T00:00:00.000Z';
            context.timezone = '-05:00';
            params.filter.occurredAt.$dateOn = '2027-01-01';
            if (kind === 'sum') params.field = 'id';
            return original(...args);
          });
          expect(
            await entryReads[kind === 'sum' ? 'sumFromParams' : 'countFromParams'](
              ctx,
              mainIdentity,
              auth,
              params,
              undefined,
              context,
            ),
          ).toBe(kind === 'sum' ? 30 : 2);
        },
      );
      it.each(['count', 'sum'] as const)(
        'summary params reject malformed and unauthorized %s requests before SQL',
        async (kind) => {
          const getter = vi.fn(() => ({ $dateOn: '{{$nDate.today}}' }));
          const execute = (params: object, context: typeof dates | undefined = dates) =>
            entryReads[kind === 'sum' ? 'sumFromParams' : 'countFromParams'](
              ctx,
              mainIdentity,
              auth,
              { ...(kind === 'sum' ? { field: 'amount' } : {}), ...params },
              undefined,
              context,
            );
          const query = vi.spyOn(db.sequelize, 'query');
          for (const params of [
            { filter, now: dates.now },
            { filter, timezone: dates.timezone },
            { filter, pageSize: 1 },
            { filter: { occurredAt: { $dateOn: '{{$nDate.unknown}}' } } },
            { filter: { occurredAt: { $dateOn: '2026-02-30' } } },
            { filter: { name: { $dateOn: '{{$nDate.today}}' } } },
            {
              filter: Object.defineProperty({}, 'occurredAt', { get: getter }),
            },
          ])
            await expect(execute(params)).rejects.toThrow();
          await expect(execute({ filter }, { ...dates, now: 'invalidZ' })).rejects.toThrow();
          await expect(
            entryReads[kind === 'sum' ? 'sumFromParams' : 'countFromParams'](ctx, mainIdentity, auth, {
              filter,
              ...(kind === 'sum' ? { field: 'amount' } : {}),
            }),
          ).rejects.toThrow(/unresolved/);
          permissions.set('', { allowed: true, params: { fields: ['id'], appends: [] } });
          await expect(execute({ filter })).rejects.toThrow(/authorized/);
          expect(getter).not.toHaveBeenCalled();
          expect(query).not.toHaveBeenCalled();
        },
      );
      const page = (params: object, context = dates) =>
        entryReads.listPageFromParams(
          ctx,
          mainIdentity,
          auth,
          { fields: ['id'], sort: ['id'], ...params },
          undefined,
          context,
        );
      it('shares resolved dates across page rows, counts and detail within role and tenant scopes', async () => {
        permissions.set('', { allowed: true, params: { filter: { amount: { $gte: 15 } } } });
        expect(await page({ filter, pageSize: 1 })).toEqual({
          rows: [{ id: 2 }],
          count: 1,
          page: 1,
          pageSize: 1,
          totalPage: 1,
        });
        expect(await page({ filter, pageSize: 1, page: 2 })).toEqual({
          rows: [],
          count: 1,
          page: 2,
          pageSize: 1,
          totalPage: 1,
        });
        expect(
          await entryReads.getFromParams(
            ctx,
            mainIdentity,
            auth,
            { filterByTk: 2, fields: ['id'], filter },
            undefined,
            dates,
          ),
        ).toEqual({ id: 2 });
        expect(
          await entryReads.getFromParams(
            ctx,
            mainIdentity,
            auth,
            { filterByTk: 1, fields: ['id'], filter },
            undefined,
            dates,
          ),
        ).toBeNull();
      });
      it('keeps linked date targets independently scoped and authorized', async () => {
        await projects.model.update({ occurredAt: new Date(dates.now) }, { where: { id: [101, 102] } });
        const linked = { project: { occurredAt: { $dateOn: '{{$date.today}}' } } };
        expect((await page({ filter: linked })).rows).toEqual([{ id: 1 }]);
        permissions.set('project', { allowed: true, params: { filter: { name: { $ne: 'Zebra' } } } });
        expect(await page({ filter: linked })).toMatchObject({ rows: [], count: 0 });
        permissions.set('project', null);
        const query = vi.spyOn(db.sequelize, 'query');
        await expect(page({ filter: linked })).rejects.toThrow(/authorized/);
        expect(query).not.toHaveBeenCalled();
      });
      it('resolves logical groups, dotted fields and calendar ranges without merging conditions away', async () => {
        expect((await page({ filter: { $and: [filter, { $not: { amount: { $lt: 15 } } }] } })).rows).toEqual([
          { id: 2 },
        ]);
        expect(
          (await page({ filter: { $or: [filter, { occurredAt: { $dateOn: '{{$nDate.tomorrow}}' } }] } })).rows,
        ).toEqual([{ id: 1 }, { id: 2 }, { id: 5 }]);
        expect(
          (await page({ filter: { occurredAt: { $dateBetween: '{{$nDate.today}}', $dateBefore: '{{$nDate.now}}' } } }))
            .rows,
        ).toEqual([{ id: 1 }]);
      });
      it('honors actual GMT field metadata and explicit operand offsets', async () => {
        docs.getField('occurredAt').options.uiSchema = { 'x-component-props': { gmt: true } };
        expect((await page({ filter })).rows).toEqual([{ id: 2 }, { id: 5 }]);
        expect((await page({ filter: { occurredAt: { $dateOn: '2026-09-16+08:00' } } })).rows).toEqual([
          { id: 1 },
          { id: 2 },
        ]);
        await projects.model.update({ occurredAt: new Date('2026-09-15T16:00:00Z') }, { where: { id: 101 } });
        projects.getField('occurredAt').options.uiSchema = { 'x-component-props': { gmt: true } };
        expect((await page({ filter: { 'project.occurredAt': { $dateOn: '{{$nDate.today}}' } } })).rows).toEqual([]);
      });
      it('uses the supplied clock across a local day boundary and for instant comparisons', async () => {
        const beforeDay = { now: '2026-09-15T15:59:59.999Z', timezone: '+08:00' };
        expect((await page({ filter }, beforeDay)).rows).toEqual([{ id: 4 }]);
        expect((await page({ filter: { occurredAt: { $dateOn: '{{$nDate.now}}' } } }, beforeDay)).rows).toEqual([
          { id: 4 },
        ]);
      });
      it('captures the date context and filter before asynchronous queries', async () => {
        const context = { ...dates };
        const input = { occurredAt: { $dateOn: '{{$nDate.today}}' } };
        const original = queries.scopeQuery.bind(queries);
        vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
          context.now = '2027-01-01T00:00:00.000Z';
          context.timezone = '-05:00';
          input.occurredAt.$dateOn = '2027-01-01';
          return original(...args);
        });
        expect(await page({ filter: input }, context)).toMatchObject({ rows: [{ id: 1 }, { id: 2 }], count: 2 });
      });
      it('rejects date overrides in action params and malformed or unauthorized dates before SQL', async () => {
        const query = vi.spyOn(db.sequelize, 'query');
        for (const params of [
          { filter, now: dates.now },
          { filter, timezone: dates.timezone },
          { filter, dates },
          { filter: { occurredAt: { $dateOn: '{{$nDate.unknown}}' } } },
          { filter: { name: { $dateOn: '{{$nDate.today}}' } } },
        ])
          await expect(page(params)).rejects.toThrow();
        await expect(page({ filter }, { ...dates, now: 'invalidZ' })).rejects.toThrow();
        permissions.set('', { allowed: true, params: { fields: ['id'], appends: [] } });
        await expect(page({ filter })).rejects.toThrow(/authorized/);
        expect(query).not.toHaveBeenCalled();
      });
      it('applies explicit entry timezone to implicit arrays while preserving calls without context', async () => {
        const range = { occurredAt: { $dateBetween: ['2026-09-16', '2026-09-17', '[)'] } };
        expect((await page({ filter: range })).rows).toEqual([{ id: 1 }, { id: 2 }]);
        expect(
          await entryReads.listFromParams(ctx, mainIdentity, auth, { fields: ['id'], sort: ['id'], filter: range }),
        ).toEqual([{ id: 2 }, { id: 5 }]);
        const query = vi.spyOn(db.sequelize, 'query');
        await expect(entryReads.listFromParams(ctx, mainIdentity, auth, { filter })).rejects.toThrow(/unresolved/);
        expect(query).not.toHaveBeenCalled();
      });
    });
    describe('calendar period dates', () => {
      const dates = { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' };
      const page = (filter: unknown, context = dates) =>
        entryReads.listPageFromParams(
          ctx,
          mainIdentity,
          auth,
          { fields: ['id'], sort: ['id'], filter },
          undefined,
          context,
        );
      it('distinguishes Sunday and Monday week starts in real pages and details', async () => {
        await docs.model.update({ occurredAt: new Date('2026-09-13T04:00:00Z') }, { where: { id: 1 } });
        await docs.model.update({ occurredAt: new Date('2026-09-20T04:00:00Z') }, { where: { id: 2 } });
        const ordinary = { occurredAt: { $dateOn: '{{$nDate.thisWeek}}' } };
        const iso = { occurredAt: { $dateOn: '{{$nDate.thisIsoWeek}}' } };
        expect(await page(ordinary)).toMatchObject({ rows: [{ id: 1 }, { id: 4 }, { id: 5 }], count: 3 });
        expect(await page(iso)).toMatchObject({ rows: [{ id: 2 }, { id: 4 }, { id: 5 }], count: 3 });
        expect(
          await entryReads.getFromParams(
            ctx,
            mainIdentity,
            auth,
            { fields: ['id'], filterByTk: 1, filter: iso },
            undefined,
            dates,
          ),
        ).toBeNull();
        expect(
          await entryReads.getFromParams(
            ctx,
            mainIdentity,
            auth,
            { fields: ['id'], filterByTk: 1, filter: ordinary },
            undefined,
            dates,
          ),
        ).toEqual({ id: 1 });
        permissions.set('', { allowed: true, params: { filter: { amount: { $lt: 40 } } } });
        expect(await page(iso)).toMatchObject({ rows: [{ id: 2 }], count: 1 });
      });
      describe('quarter boundaries', () => {
        beforeEach(async () => {
          for (const [id, instant] of [
            [1, '2026-06-30T16:00:00.000Z'],
            [2, '2026-09-30T15:59:59.999Z'],
            [4, '2026-06-30T15:59:59.999Z'],
            [5, '2026-09-30T16:00:00.000Z'],
          ] as const)
            await docs.model.update({ occurredAt: new Date(instant) }, { where: { id } });
        });
        it('preserves full quarter boundaries for calendar operators and field GMT', async () => {
          for (const [operator, ids] of [
            ['$dateOn', [1, 2]],
            ['$dateNotOn', [4, 5]],
            ['$dateBefore', [4]],
            ['$dateNotBefore', [1, 2, 5]],
            ['$dateAfter', [5]],
            ['$dateNotAfter', [1, 2, 4]],
            ['$dateBetween', [1, 2]],
          ] as const)
            expect(await page({ occurredAt: { [operator]: '{{$date.thisQuarter}}' } })).toMatchObject({
              rows: ids.map((id) => ({ id })),
              count: ids.length,
            });
          docs.getField('occurredAt').options.uiSchema = { 'x-component-props': { gmt: true } };
          expect((await page({ occurredAt: { $dateOn: '{{$nDate.thisQuarter}}' } })).rows).toEqual([
            { id: 2 },
            { id: 5 },
          ]);
        });
        it('uses finalized role period conditions without exposing hidden date fields', async () => {
          permissions.set('', {
            allowed: true,
            params: {
              fields: ['id'],
              appends: [],
              filter: { occurredAt: { $dateOn: '2026Q3+08:00' } },
            },
          });
          expect(await entryList()).toEqual([{ id: 1 }, { id: 2 }]);
          expect(await entryReads.count(ctx, mainIdentity, auth)).toBe(2);
          await expect(page({ occurredAt: { $dateOn: '{{$nDate.thisQuarter}}' } })).rejects.toThrow(/authorized/);
        });
      });
      it('intersects period filters with linked target visibility and role conditions', async () => {
        await projects.model.update({ occurredAt: new Date(dates.now) }, { where: { id: [101, 102] } });
        await projects.model.update({ occurredAt: new Date('2026-10-01T00:00:00Z') }, { where: { id: 103 } });
        const linked = { project: { occurredAt: { $dateOn: '{{$nDate.thisQuarter}}' } } };
        expect(await page(linked)).toMatchObject({ rows: [{ id: 1 }], count: 1 });
        permissions.set('project', {
          allowed: true,
          params: { filter: { occurredAt: { $dateBefore: '2026Q3+08:00' } } },
        });
        expect(await page(linked)).toMatchObject({ rows: [], count: 0 });
      });
      it('keeps ISO week 53 in its week year when the calendar year has changed', async () => {
        for (const [id, instant] of [
          [1, '2020-12-27T16:00:00.000Z'],
          [2, '2021-01-03T15:59:59.999Z'],
          [4, '2020-12-27T15:59:59.999Z'],
          [5, '2021-01-03T16:00:00.000Z'],
        ] as const)
          await docs.model.update({ occurredAt: new Date(instant) }, { where: { id } });
        const context = { now: '2021-01-01T00:00:00.000Z', timezone: '+08:00' };
        expect(await page({ occurredAt: { $dateOn: '{{$nDate.thisIsoWeek}}' } }, context)).toMatchObject({
          rows: [{ id: 1 }, { id: 2 }],
          count: 2,
        });
        expect(await page({ occurredAt: { $dateOn: '{{$nDate.thisWeek}}' } }, context)).toMatchObject({
          rows: [{ id: 1 }, { id: 4 }],
          count: 2,
        });
      });
      it('rejects nonexistent week and quarter labels before SQL', async () => {
        const query = vi.spyOn(db.sequelize, 'query');
        for (const value of ['2021W53', '2026w53', '2026W54', '2026Q5', '2026Q3+15:00'])
          await expect(page({ occurredAt: { $dateOn: value } })).rejects.toThrow();
        expect(query).not.toHaveBeenCalled();
      });
    });
    it.each([
      ['$dateOn', [1, 2]],
      ['$dateNotOn', [4, 5]],
      ['$dateBefore', [4]],
      ['$dateNotBefore', [1, 2, 5]],
      ['$dateAfter', [5]],
      ['$dateNotAfter', [1, 2, 4]],
      ['$dateBetween', [1, 2]],
    ])('keeps %s calendar boundaries, NULL and tenant restrictions', async (operator, ids) => {
      await docs.model.create({ id: 8, tenantId: 'B', name: 'No date', amount: 80 });
      const value = operator === '$dateBetween' ? '[2026-09-16,2026-09-17)+08:00' : '2026-09-16+08:00';
      expect(
        await entryReads.list(ctx, mainIdentity, auth, {
          attributes: ['id'],
          sort: ['id'],
          filter: { occurredAt: { [operator as string]: value } },
        }),
      ).toEqual((ids as number[]).map((id) => ({ id })));
    });
    it.each([
      ['$dateOn', [1]],
      ['$dateNotOn', [2, 4, 5]],
      ['$dateBefore', [4]],
      ['$dateNotBefore', [1, 2, 5]],
      ['$dateAfter', [2, 5]],
      ['$dateNotAfter', [1, 4]],
    ])('retains %s instant comparisons instead of calendar precision', async (operator, ids) => {
      expect(
        await entryReads.list(ctx, mainIdentity, auth, {
          attributes: ['id'],
          sort: ['id'],
          filter: { occurredAt: { [operator as string]: '2026-09-15T16:00:00.000Z' } },
        }),
      ).toEqual((ids as number[]).map((id) => ({ id })));
    });
    it('uses the same date and role conditions for pages, detail, counts and sums', async () => {
      const filter = { occurredAt: { $dateOn: '2026-09-16+08:00' } };
      permissions.set('', { allowed: true, params: { filter: { amount: { $gte: 15 } } } });
      expect(
        await entryReads.listPageFromParams(ctx, mainIdentity, auth, {
          fields: ['name'],
          filter,
          pageSize: 1,
          page: 1,
        }),
      ).toEqual({ rows: [{ name: 'Visible' }], count: 1, page: 1, pageSize: 1, totalPage: 1 });
      expect(
        await entryReads.listPageFromParams(ctx, mainIdentity, auth, {
          fields: ['name'],
          filter,
          pageSize: 1,
          page: 2,
        }),
      ).toEqual({ rows: [], count: 1, page: 2, pageSize: 1, totalPage: 1 });
      expect(await entryReads.count(ctx, mainIdentity, auth, { filter })).toBe(1);
      expect(await entryReads.sum(ctx, mainIdentity, auth, { field: 'amount', filter })).toBe(20);
      expect(
        await entryReads.getFromParams(ctx, mainIdentity, auth, { filterByTk: 2, fields: ['name'], filter }),
      ).toEqual({ name: 'Visible' });
      expect(
        await entryReads.getFromParams(ctx, mainIdentity, auth, { filterByTk: 1, fields: ['name'], filter }),
      ).toBeNull();
    });
    it('allows hidden date fields in finalized root role conditions but not user filtering', async () => {
      permissions.set('', {
        allowed: true,
        params: {
          fields: ['id', 'amount'],
          appends: [],
          filter: { occurredAt: { $dateOn: '2026-09-16+08:00' } },
        },
      });
      expect(await entryList()).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await entryReads.count(ctx, mainIdentity, auth)).toBe(2);
      expect(await entryReads.sum(ctx, mainIdentity, auth, { field: 'amount' })).toBe(30);
      await expect(entryList({ filter: { occurredAt: { $dateOn: '2026-09-16+08:00' } } })).rejects.toThrow(
        /authorized/,
      );
    });
    it('allows internal relationship date facts without granting target payload access', async () => {
      await projects.model.update({ occurredAt: new Date('2026-09-16T00:00:00Z') }, { where: { id: 102 } });
      permissions.set('', {
        allowed: true,
        params: {
          fields: ['id'],
          appends: [],
          filter: { project: { occurredAt: { $dateOn: '2026-09-16+08:00' } } },
        },
      });
      permissions.set('project', { allowed: false, params: {} });
      expect(await entryList()).toEqual([{ id: 2 }]);
      await expect(entryList({ filter: { project: { occurredAt: { $dateOn: '2026-09-16+08:00' } } } })).rejects.toThrow(
        /authorized/,
      );
    });
    it('independently constrains targets of public relationship date filters', async () => {
      await projects.model.update({ occurredAt: new Date('2026-09-16T00:00:00Z') }, { where: { id: [101, 102] } });
      const filter = { project: { occurredAt: { $dateOn: '2026-09-16+08:00' } } };
      expect(await entryList({ filter })).toEqual([{ id: 1 }]);
      permissions.set('project', { allowed: true, params: { filter: { name: { $ne: 'Zebra' } } } });
      expect(await entryList({ filter })).toEqual([]);
    });
    it('intersects multiple date operators on the same field', async () => {
      expect(
        await entryList({
          filter: {
            occurredAt: {
              $dateOn: '2026-09-16+08:00',
              $dateBefore: '2026-09-16T00:00:00.000Z',
            },
          },
        }),
      ).toEqual([{ id: 1 }]);
    });
    it.each([false, true])('does not merge away conflicting date predicates (reverse=%s)', async (reverse) => {
      const entries: Array<[string, unknown]> = [
        ['$dateOn', '2026-09-16+08:00'],
        ['$dateBetween', '[2026-09-17,2026-09-18)+08:00'],
      ];
      const filter = { occurredAt: Object.fromEntries(reverse ? entries.reverse() : entries) };
      expect(await entryList({ filter })).toEqual([]);
      permissions.set('', { allowed: true, params: { fields: ['id'], filter } });
      expect(await entryList()).toEqual([]);
    });
    it('uses the captured scalar timezone and the core UTC default for array ranges', async () => {
      db.options.timezone = '+08:00';
      expect(await entryList({ filter: { occurredAt: { $dateOn: '2026-09-16' } } })).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await entryList({ filter: { occurredAt: { $dateOn: '2026-09-16+00:00' } } })).toEqual([
        { id: 2 },
        { id: 5 },
      ]);
      expect(await entryList({ filter: { occurredAt: { $dateBetween: ['2026-09-16', '2026-09-17', '[)'] } } })).toEqual(
        [{ id: 2 }, { id: 5 }],
      );
      expect(
        await entryList({ filter: { occurredAt: { $dateBetween: ['2026-09-16', '2026-09-17', '[)', '+08:00'] } } }),
      ).toEqual([{ id: 1 }, { id: 2 }]);
    });
    it('snapshots date range arrays and timezone before asynchronous scope queries', async () => {
      db.options.timezone = '+08:00';
      const range = ['2026-09-16', '2026-09-17', '[)', '+08:00'];
      const original = queries.scopeQuery.bind(queries);
      vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
        range[0] = '2027-01-01';
        db.options.timezone = '-05:00';
        return original(...args);
      });
      expect(await entryList({ filter: { occurredAt: { $dateBetween: range } } })).toEqual([{ id: 1 }, { id: 2 }]);
    });
    it('rejects unresolved and invalid date filters before SQL', async () => {
      const query = vi.spyOn(db.sequelize, 'query');
      for (const filter of [
        { occurredAt: { $dateOn: '{{$nDate.today}}' } },
        { occurredAt: { $dateOn: '2026-02-29' } },
        { name: { $dateOn: '2026-09-16' } },
      ])
        await expect(entryList({ filter })).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    });
    it('preserves core DATEONLY predicates on a registered physical date field', async () => {
      await docs.model.update({ calendarDate: '2026-09-16' }, { where: { id: [1, 2] } });
      for (const operator of [
        '$dateOn',
        '$dateNotOn',
        '$dateBefore',
        '$dateNotBefore',
        '$dateAfter',
        '$dateNotAfter',
        '$dateBetween',
      ]) {
        const value = operator === '$dateBetween' ? '[2026-09-16,2026-09-17)+00:00' : '2026-09-16+00:00';
        const filter = { calendarDate: { [operator]: value } };
        const parsed = new FilterParser(filter, { collection: docs }).toSequelizeParams();
        const expected = await docs.model.findAll({
          attributes: ['id'],
          where: { [Op.and]: [parsed.where!, { id: [1, 2, 4, 5] }] },
          order: [['id', 'ASC']],
          raw: true,
        });
        expect(await entryList({ filter, sort: ['id'] })).toEqual(expected);
      }
      expect(await entryList({ filter: { calendarDate: { $dateOn: '2026-09-16+00:00' } } })).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "read_documents", "read_projects", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });
  const list = (request: object = {}) => reads.list(ctx, mainIdentity, auth, { attributes: ['id'], ...request });
  const get = (key: unknown, request: object = {}) =>
    reads.get(ctx, mainIdentity, auth, { key, attributes: ['id'], ...request });
  const count = (filter: unknown = {}) => reads.count(ctx, mainIdentity, auth, { filter });
  const sum = (filter: unknown = {}) => reads.sum(ctx, mainIdentity, auth, { field: 'amount', filter });
  const entryList = (request: object = {}) =>
    entryReads.list(ctx, mainIdentity, auth, { attributes: ['id'], ...request });
  const entryOperation = (kind: 'list' | 'get' | 'count' | 'sum') => {
    if (kind === 'list') return entryList();
    if (kind === 'get') return entryReads.get(ctx, mainIdentity, auth, { key: 2, attributes: ['id'] });
    if (kind === 'count') return entryReads.count(ctx, mainIdentity, auth);
    return entryReads.sum(ctx, mainIdentity, auth, { field: 'amount' });
  };
  describe('parsed resource routing', () => {
    const action = { resourceName: 'documents.project', sourceId: '_', actionName: 'get' };
    it('reads a placeholder target within its own role and tenant scope without a source row', async () => {
      expect(await entryReads.fromResource(ctx, auth, action, { filterByTk: 101, fields: ['name'] })).toEqual({
        name: 'Zebra',
      });
      expect(await entryReads.fromResource(ctx, auth, action, { filterByTk: 102, fields: ['name'] })).toBeNull();
      expect(entryResolver.mock.calls.every(([collection, path]) => collection === projects && path.length === 0)).toBe(
        true,
      );
    });
  });
  describe('parsed resource routing boundaries', () => {
    const action = { resourceName: 'documents.project', sourceId: '_', actionName: 'get' };
    it('keeps placeholder source configuration out of direct target reads', async () => {
      adapter.release(ctx);
      await adapter.prepare(ctx, [projectIdentity]);
      expect(await entryReads.fromResource(ctx, auth, action, { filterByTk: 103, fields: ['name'] })).toEqual({
        name: 'Alpha',
      });
      expect(entryResolver.mock.calls.every(([collection]) => collection === projects)).toBe(true);
    });
    it('uses core direct target semantics rather than applying a relation scope or requiring a link', async () => {
      const relation = docs.model.associations.project as typeof docs.model.associations.project & { scope?: object };
      relation.scope = { name: 'Not an existing project' };
      const expected = (
        await projects.repository.find({ fields: ['name'], filter: { tenantId: 'B' }, sort: ['id'] })
      ).map((record: Model) => ({ name: record.getDataValue('name') }));
      expect(expected).toEqual([{ name: 'Zebra' }, { name: 'Alpha' }]);
      expect(
        await entryReads.fromResource(
          ctx,
          auth,
          { ...action, actionName: 'list' },
          { fields: ['name'], sort: ['id'], pageSize: 1, page: 2 },
        ),
      ).toEqual({ rows: [{ name: 'Alpha' }], count: 2, page: 2, pageSize: 1, totalPage: 2 });
    });
    it('applies target final role filters and rejects unauthorized projection and operations before SQL', async () => {
      permissions.set('', { allowed: true, params: { fields: ['name'], filter: { name: 'Alpha' } } });
      expect(await entryReads.fromResource(ctx, auth, action, { filterByTk: 101, fields: ['name'] })).toBeNull();
      expect(await entryReads.fromResource(ctx, auth, action, { filterByTk: 103, fields: ['name'] })).toEqual({
        name: 'Alpha',
      });
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(entryReads.fromResource(ctx, auth, action, { filterByTk: 101, fields: ['amount'] })).rejects.toThrow(
        /authorized/,
      );
      permissions.set('', null);
      await expect(entryReads.fromResource(ctx, auth, action, { filterByTk: 101 })).rejects.toThrow(/authorized/);
      expect(query).not.toHaveBeenCalled();
    });
    it('uses the configured target detail key and preserves explicit field selection', async () => {
      projects.options.filterTargetKey = 'name';
      permissions.set('', { allowed: true, params: { fields: ['id'] } });
      expect(await entryReads.fromResource(ctx, auth, action, { filterByTk: 'Zebra', fields: ['id'] })).toEqual({
        id: 101,
      });
      expect(await entryReads.fromResource(ctx, auth, action, { filterByTk: 'Secret', fields: ['id'] })).toBeNull();
    });
    it('reuses the trusted date context for direct target pages', async () => {
      await projects.model.update({ occurredAt: new Date('2026-09-15T16:00:00Z') }, { where: { id: [101, 102] } });
      expect(
        await entryReads.fromResource(
          ctx,
          auth,
          { ...action, actionName: 'list' },
          { fields: ['name'], filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } } },
          undefined,
          { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' },
        ),
      ).toEqual({ rows: [{ name: 'Zebra' }], count: 1, page: 1, pageSize: 20, totalPage: 1 });
    });
    it('dispatches root list, get, count and sum with their original operation decisions', async () => {
      const root = { resourceName: 'documents', actionName: 'list' };
      expect(await entryReads.fromResource(ctx, auth, root, { fields: ['id'], sort: ['id'], pageSize: 2 })).toEqual({
        rows: [{ id: 1 }, { id: 2 }],
        count: 4,
        page: 1,
        pageSize: 2,
        totalPage: 2,
      });
      expect(
        await entryReads.fromResource(ctx, auth, { ...root, actionName: 'get' }, { fields: ['id'], filterByTk: 2 }),
      ).toEqual({ id: 2 });
      expect(await entryReads.fromResource(ctx, auth, { ...root, actionName: 'count' }, {})).toBe(4);
      expect(await entryReads.fromResource(ctx, auth, { ...root, actionName: 'sum' }, { field: 'amount' })).toBe(120);
    });
    it('routes concrete belongs-to sources without bypassing default scope or deletion', async () => {
      for (const sourceId of [1, '1'])
        expect(
          await entryReads.fromResource(ctx, auth, { ...action, sourceId }, { fields: ['name'], filterByTk: 103 }),
        ).toEqual({ name: 'Zebra' });
      for (const sourceId of [3, 6, 7])
        await expect(
          entryReads.fromResource(ctx, auth, { ...action, sourceId }, { fields: ['name'] }),
        ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await entryReads.fromResource(ctx, auth, { ...action, sourceId: 2 }, { fields: ['name'] })).toBeNull();
      expect(await entryReads.fromResource(ctx, auth, { ...action, sourceId: 5 }, { fields: ['name'] })).toBeNull();
    });
    it.each([null, ''])('rejects malformed source ID %j before SQL', async (sourceId) => {
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(entryReads.fromResource(ctx, auth, { ...action, sourceId }, { filterByTk: 101 })).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    });
    it('captures the route and request params before asynchronous queries', async () => {
      const mutableAction = { ...action };
      const params = { filterByTk: 101, fields: ['name'] };
      const original = queries.scopeQuery.bind(queries);
      vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
        mutableAction.resourceName = 'documents';
        mutableAction.actionName = 'list';
        params.filterByTk = 103;
        params.fields[0] = 'amount';
        return original(...args);
      });
      expect(await entryReads.fromResource(ctx, auth, mutableAction, params)).toEqual({ name: 'Zebra' });
    });
    it('rejects a changed association before returning query results', async () => {
      const original = queries.scopeQuery.bind(queries);
      vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
        delete docs.model.associations.project;
        return original(...args);
      });
      await expect(entryReads.fromResource(ctx, auth, action, { filterByTk: 101, fields: ['name'] })).rejects.toThrow(
        /association changed/,
      );
    });
  });
  it('summary params require the specific operation permission rather than list permission', async () => {
    const kinds: string[] = [];
    entryReads = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => identities.find((identity) => identity.collectionName === collection.name),
      (_collection, _path, operation) => {
        kinds.push(operation.kind);
        return { allowed: operation.kind === 'count', params: { fields: ['id'] } };
      },
    );
    expect(await entryReads.countFromParams(ctx, mainIdentity, auth, {})).toBe(4);
    const query = vi.spyOn(db.sequelize, 'query');
    await expect(entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount' })).rejects.toThrow(/authorized/);
    await expect(entryReads.listFromParams(ctx, mainIdentity, auth, { fields: ['id'] })).rejects.toThrow(/authorized/);
    expect(query).not.toHaveBeenCalled();
    expect(kinds).toEqual(['count', 'sum', 'list']);
  });
  it('summary params reject nonnumeric and unauthorized root sum fields before SQL', async () => {
    const query = vi.spyOn(db.sequelize, 'query');
    for (const field of ['name', 'labels', 'occurredAt', 'project.amount', 'missing', 'amount; DROP TABLE documents'])
      await expect(entryReads.sumFromParams(ctx, mainIdentity, auth, { field })).rejects.toThrow();
    permissions.set('', { allowed: true, params: { fields: ['id'], appends: [] } });
    await expect(entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount' })).rejects.toThrow(/authorized/);
    expect(query).not.toHaveBeenCalled();
  });
  it('entry supports relational finalized ACL conditions across all four reads without exposing fact fields', async () => {
    const acl = new ACL();
    acl.setAvailableAction('view', { aliases: ['get', 'list'] });
    const role = acl.define({ role: 'reader' });
    role.grantAction('documents:view', {
      fields: ['id', 'amount'],
      appends: [],
      filter: { 'project.name': '{{ ctx.state.currentUser.projectName }}' },
    });
    acl.addFixedParams('documents', 'list', () => ({ filter: { amount: { $gte: 15 } } }));
    const can = acl.can({ role: 'reader', resource: 'documents', action: 'list' })!;
    const params = await acl.parseJsonTemplate(structuredClone(can.params), {
      db,
      state: { currentRole: 'reader', currentUser: { projectName: 'Secret' } },
    } as unknown as Parameters<ACL['parseJsonTemplate']>[1]);
    permissions.set('', { allowed: true, params });
    permissions.set('project', { allowed: false, params: {} });
    expect(await entryOperation('list')).toEqual([{ id: 2 }]);
    expect(await entryOperation('get')).toEqual({ id: 2 });
    expect(await entryOperation('count')).toBe(1);
    expect(await entryOperation('sum')).toBe(20);
    await expect(entryList({ attributes: ['name'] })).rejects.toThrow(/authorized/);
    await expect(entryList({ filter: { project: { name: 'Secret' } } })).rejects.toThrow(/authorized/);
    expect(entryResolver.mock.calls.every(([, path]) => !path.length)).toBe(true);
  });
  it('entry keeps role conditions and G/V outside an OR request filter', async () => {
    permissions.set('', { allowed: true, params: { filter: { project: { name: 'Zebra' } } } });
    expect(await entryList({ filter: { $or: [{ id: 3 }, { id: 1 }, { id: 2 }] } })).toEqual([{ id: 1 }]);
    expect(await entryReads.get(ctx, mainIdentity, auth, { key: 3, attributes: ['id'] })).toBeNull();
  });
  it('entry request associations remain scoped independently of role authorization facts', async () => {
    permissions.set('', {
      allowed: true,
      params: { fields: ['id', 'amount'], appends: ['project'], filter: { project: { name: 'Secret' } } },
    });
    permissions.set('project', { allowed: true, params: { fields: ['name'] } });
    expect(await entryList({ sort: ['project.name'] })).toEqual([{ id: 2 }]);
    const filter = { project: { name: 'Secret' } };
    expect(await entryList({ filter })).toEqual([]);
    expect(await entryReads.count(ctx, mainIdentity, auth, { filter })).toBe(0);
    expect(await entryReads.sum(ctx, mainIdentity, auth, { field: 'amount', filter })).toBeNull();
  });
  it.each(['list', 'get', 'count', 'sum'] as const)(
    'entry denies missing operation permission for %s',
    async (kind) => {
      permissions.set('', { allowed: false, params: {} });
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(entryOperation(kind)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('entry snapshots permission JSON before asynchronous scope resolution and refreshes each operation', async () => {
    const permission = { allowed: true, params: { fields: ['id'], filter: { project: { name: 'Secret' } } } };
    permissions.set('', permission);
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      permission.params.filter.project.name = 'Zebra';
      permission.params.fields[0] = 'amount';
      return original(...args);
    });
    expect(await entryList()).toEqual([{ id: 2 }]);
    expect(await entryList({ attributes: ['amount'] })).toEqual([{ amount: 10 }]);
    expect(entryResolver.mock.calls.filter(([, path]) => !path.length)).toHaveLength(2);
  });
  it('entry isolates simultaneous reads on the same service', async () => {
    permissions.set('', { allowed: true, params: { filter: { project: { name: 'Secret' } } } });
    let resume!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const first = entryList();
    try {
      await Promise.race([started, first]);
      permissions.set('', { allowed: true, params: { filter: { project: { name: 'Zebra' } } } });
      expect(await entryList()).toEqual([{ id: 1 }]);
    } finally {
      resume();
    }
    expect(await first).toEqual([{ id: 2 }]);
  });
  it('entry resolves permissions for the specific operation and trusted identity', async () => {
    const kinds: string[] = [];
    entryReads = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => identities.find((identity) => identity.collectionName === collection.name),
      (_collection, _path, operation) => {
        expect(operation.context).toBe(ctx);
        expect(operation.source).toEqual(mainIdentity);
        expect(operation.authenticated).toEqual(auth);
        kinds.push(operation.kind);
        return { allowed: operation.kind !== 'get', params: { fields: ['id', 'amount'] } };
      },
    );
    expect(await entryOperation('list')).toHaveLength(4);
    await expect(entryOperation('get')).rejects.toThrow(/authorized/);
    expect(await entryOperation('count')).toBe(4);
    expect(await entryOperation('sum')).toBe(120);
    expect(kinds).toEqual(['list', 'get', 'count', 'sum']);
  });
  it.each([
    'fields prototype',
    'appends prototype',
    'permission prototype',
    'hidden permission key',
    'hidden params key',
    'hidden own',
  ])('entry rejects malformed permission %s before cloning or spreading', async (invalidCase) => {
    const permission = { allowed: true, params: { fields: ['id'], appends: ['project'] } };
    if (invalidCase === 'fields prototype')
      Object.setPrototypeOf(permission.params.fields, Object.create(Array.prototype));
    if (invalidCase === 'appends prototype')
      Object.setPrototypeOf(permission.params.appends, Object.create(Array.prototype));
    if (invalidCase === 'permission prototype') Object.setPrototypeOf(permission, { custom: true });
    if (invalidCase === 'hidden permission key') Object.defineProperty(permission, 'extra', { value: true });
    if (invalidCase === 'hidden params key') Object.defineProperty(permission.params, 'extra', { value: true });
    if (invalidCase === 'hidden own') Object.defineProperty(permission.params, 'own', { value: true });
    permissions.set('', permission);
    const query = vi.spyOn(db.sequelize, 'query');
    await expect(entryList()).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('entry preserves non-enumerable field restrictions', async () => {
    permissions.set('', { allowed: true, params: Object.defineProperty({}, 'fields', { value: ['id'] }) });
    expect(await entryList()).toHaveLength(4);
    await expect(entryList({ attributes: ['name'] })).rejects.toThrow(/authorized/);
  });
  it('entry rejects changed role-only metadata during scope preparation before root SQL', async () => {
    permissions.set('', { allowed: true, params: { filter: { project: { name: 'Secret' } } } });
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      projects.model.rawAttributes.name.field = 'changed_field';
      return result;
    });
    const find = vi.spyOn(docs.model, 'findAll');
    await expect(entryList()).rejects.toThrow(/changed/);
    expect(find).not.toHaveBeenCalled();
  });
  it.each(['list', 'get', 'count', 'sum'] as const)(
    'entry checks role-only metadata after executing %s',
    async (kind) => {
      permissions.set('', { allowed: true, params: { filter: { project: { name: 'Secret' } } } });
      const query = db.sequelize.query.bind(db.sequelize);
      vi.spyOn(db.sequelize, 'query').mockImplementation(async (...args) => {
        const result = await query(...args);
        if (String(args[0]).includes('read_documents')) projects.model.rawAttributes.name.field = 'changed_field';
        return result;
      });
      await expect(entryOperation(kind)).rejects.toThrow(/changed/);
    },
  );
  it('entry checks sort-only target role facts captured before filtering awaits', async () => {
    projects.setField('related', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    await projects.model.update({ projectId: 103 }, { where: { id: 101 } });
    permissions.set('project', { allowed: true, params: { fields: ['name'], filter: { related: { name: 'Alpha' } } } });
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      Object.assign(projects.model.associations.related, { scope: { name: 'Zebra' } });
      return result;
    });
    const find = vi.spyOn(docs.model, 'findAll');
    await expect(entryList({ sort: ['project.name'] })).rejects.toThrow(/changed/);
    expect(find).not.toHaveBeenCalled();
  });
  it('uses the same G/V and root constraints for all four operations', async () => {
    expect(await list()).toEqual([1, 2, 4, 5].map((id) => ({ id })));
    expect(await count()).toBe(4);
    expect(await sum()).toBe(120);
    expect(await get(2)).toEqual({ id: 2 });
    for (const id of [3, 6, 7, 999]) expect(await get(id)).toBeNull();
  });
  it('uses finalized role grants consistently without exposing role-filter fields', async () => {
    const acl = new ACL();
    acl.setAvailableAction('view', { aliases: ['get', 'list'] });
    const role = acl.define({ role: 'reader' });
    role.grantAction('documents:view', {
      fields: ['id', 'amount'],
      appends: ['project'],
      filter: { name: '{{ ctx.state.currentUser.name }}' },
    });
    role.grantAction('projects:view', { fields: ['name'], filter: { name: 'Zebra' } });
    acl.addFixedParams('documents', 'list', () => ({ filter: { amount: { $gte: 15 } } }));
    const entry = new AccessReadGrantAdapter(db, (collection) =>
      accessCollectionKey(identities.find((identity) => identity.collectionName === collection.name)!),
    );
    for (const identity of identities) {
      const can = acl.can({ role: 'reader', resource: identity.collectionName, action: 'list' })!;
      const params = await acl.parseJsonTemplate(structuredClone(can.params), {
        db,
        state: { currentRole: 'reader', currentUser: { name: 'Visible' } },
      } as unknown as Parameters<ACL['parseJsonTemplate']>[1]);
      grants.set(identity === mainIdentity ? '' : 'project', entry.capture(identity, { allowed: true, params }));
    }
    expect(await list()).toEqual([{ id: 2 }]);
    expect(await count()).toBe(1);
    expect(await sum()).toBe(20);
    expect(await get(2)).toEqual({ id: 2 });
    expect(await get(1)).toBeNull();
    const filter = { project: { name: 'Secret' } };
    expect(await list({ filter })).toEqual([]);
    expect(await count(filter)).toBe(0);
    expect(await sum(filter)).toBeNull();
    expect(await get(2, { filter })).toBeNull();
    await expect(list({ attributes: ['name'] })).rejects.toThrow(/authorized/);
  });
  it('combines parsed association filters with ordering without changing aggregate roots', async () => {
    const filter = { project: { name: { $includes: 'a' } } };
    expect(await list({ filter, sort: ['project.name'] })).toEqual([{ id: 4 }, { id: 1 }]);
    expect(await count(filter)).toBe(2);
    expect(await sum(filter)).toBe(50);
    expect(await get(1, { filter })).toEqual({ id: 1 });
    expect(await get(2, { filter })).toBeNull();
    expect(await list({ filter: { project: { name: 'Secret' } } })).toEqual([]);
  });
  it('intersects root and target role grants and preserves named bindings', async () => {
    grants.set('', {
      identity: mainIdentity,
      fields: ['id', 'amount', 'project'],
      where: literal('"documents"."record_id" <> $excluded'),
      bind: { excluded: 5 },
    });
    grants.set('project', {
      identity: projectIdentity,
      fields: ['name'],
      where: literal('"projects"."display_name" = $wanted'),
      bind: { wanted: 'Zebra' },
    });
    const filter = { project: { name: { $includes: 'a' } } };
    expect(await list({ filter, sort: ['project.name'] })).toEqual([{ id: 1 }]);
    expect(await count(filter)).toBe(1);
    expect(await sum(filter)).toBe(10);
    expect(await list({ sort: ['project.name'] })).toEqual([{ id: 1 }, { id: 2 }, { id: 4 }]);
  });
  it('reserves sort-only grant binding names before compiling filters', async () => {
    grants.set('project', {
      identity: projectIdentity,
      fields: ['name'],
      where: literal('"projects"."display_name" = $tac_scope0_0'),
      bind: { tac_scope0_0: 'Zebra' },
    });
    expect(await list({ sort: ['project.name'] })).toEqual([1, 2, 4, 5].map((id) => ({ id })));
    expect(await count()).toBe(4);
    expect(await sum()).toBe(120);
  });
  it('returns large authorized JSON values without applying mutation input limits', async () => {
    const labels = Array.from({ length: 10000 }, (_, index) => index);
    await docs.model.update({ labels }, { where: { id: 1 } });
    expect(await list({ attributes: ['labels'], filter: { id: 1 } })).toEqual([{ labels }]);
    expect(await get(1, { attributes: ['labels'] })).toEqual({ labels });
  });
  it('projects only authorized physical values without getters or internal keys', async () => {
    const getter = vi.fn(() => 'secret getter');
    Object.defineProperty(docs.model.rawAttributes.name, 'get', { value: getter, configurable: true });
    (docs.model as typeof docs.model & { refreshAttributes(): void }).refreshAttributes();
    expect((await docs.model.findByPk(1))?.get('name')).toBe('secret getter');
    getter.mockClear();
    grants.set('', { identity: mainIdentity, fields: ['name'] });
    expect(await list({ attributes: ['name'], limit: 1 })).toEqual([{ name: 'Owned' }]);
    expect(await get(1, { attributes: ['name'] })).toEqual({ name: 'Owned' });
    expect(getter).not.toHaveBeenCalled();
    await expect(list({ attributes: ['id'] })).rejects.toThrow();
    await expect(sum()).rejects.toThrow();
  });
  it('keeps page order stable with hidden targets last in both directions', async () => {
    expect(await list({ sort: ['project.name'], limit: 2 })).toEqual([{ id: 4 }, { id: 1 }]);
    expect(await list({ sort: ['project.name'], limit: 2, offset: 2 })).toEqual([{ id: 2 }, { id: 5 }]);
    expect(await list({ sort: ['-project.name'] })).toEqual([1, 4, 2, 5].map((id) => ({ id })));
    expect(await count()).toBe(4);
  });
  it('returns zero count and null sum for an empty readable set', async () => {
    const filter = { name: 'Missing' };
    expect(await list({ filter })).toEqual([]);
    expect(await count(filter)).toBe(0);
    expect(await sum(filter)).toBeNull();
  });
  it('reads an explicitly shared model without a tenant column or tenant identity', async () => {
    const key = (collection: Collection) =>
      accessCollectionKey(identities.find((i) => i.collectionName === collection.name)!);
    const store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: key }),
    );
    await store.save(
      projectIdentity,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
      { userId: 28 },
    );
    await db.sequelize.getQueryInterface().removeColumn('read_projects', 'tenant_id');
    projects.removeField('tenantId');
    adapter.release(ctx);
    await adapter.prepare(ctx, identities);
    const query = vi.spyOn(db.sequelize, 'query');
    expect(await reads.list(ctx, projectIdentity, {}, { attributes: ['name'] })).toEqual([
      { name: 'Zebra' },
      { name: 'Secret' },
      { name: 'Alpha' },
    ]);
    expect(await reads.get(ctx, projectIdentity, {}, { key: 102, attributes: ['name'] })).toEqual({ name: 'Secret' });
    expect(await reads.count(ctx, projectIdentity, {})).toBe(3);
    expect(await reads.sum(ctx, projectIdentity, {}, { field: 'amount' })).toBeNull();
    expect(
      await entryReads.fromResource(
        ctx,
        {},
        { resourceName: 'documents.project', sourceId: '_', actionName: 'get' },
        { filterByTk: 102, fields: ['name'] },
      ),
    ).toEqual({ name: 'Secret' });
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('tenant_id');
  });
  it('rejects virtual projection and missing root grants', async () => {
    docs.setField('derived', { type: 'virtual', get: () => 'Secret' });
    await expect(list({ attributes: ['derived'] })).rejects.toThrow();
    grants.set('', null);
    await expect(list()).rejects.toThrow();
    await expect(count()).rejects.toThrow();
    await expect(sum()).rejects.toThrow();
  });
  it.each([
    { limit: 0 },
    { limit: 1001 },
    { limit: '20' },
    { offset: -1 },
    { offset: 1000001 },
    { offset: 1.1 },
    { attributes: [] },
    { attributes: ['nope'] },
    { attributes: ['project'] },
    { attributes: ['id', 'id'] },
    { attributes: ['id'], include: ['project'] },
    { raw: true },
    { where: {} },
    { bind: {} },
    { sort: ['amount DESC'] },
    { attributes: Object.assign([], { length: 1 }) },
  ])('rejects unsupported or malformed list requests: %j', async (request) => {
    await expect(list(request)).rejects.toThrow();
  });
  it('rejects nonnumeric and association sum fields and ORM options on non-list operations', async () => {
    for (const field of ['name', 'project.amount', 'labels', literal('amount')])
      await expect(reads.sum(ctx, mainIdentity, auth, { field })).rejects.toThrow();
    await expect(reads.count(ctx, mainIdentity, auth, { limit: 1 } as never)).rejects.toThrow();
    await expect(get('_')).rejects.toThrow();
  });
  it('rejects request accessors without invoking them', async () => {
    const getter = vi.fn(() => ['id']);
    // Pass the original object: spreading an accessor would invoke it before reaching the service.
    await expect(
      reads.list(ctx, mainIdentity, auth, Object.defineProperty({}, 'attributes', { get: getter }) as never),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('snapshots requests, identities and all grants before asynchronous scope resolution', async () => {
    const source = { ...mainIdentity };
    const authenticated = { tenantId: 'B' };
    const request = { attributes: ['id'], filter: { name: { $ne: 'Empty' } }, sort: ['project.name'] };
    const root: AccessFilterReadGrant = {
      identity: { ...mainIdentity },
      fields: ['id', 'name', 'project'],
      where: { id: { [Op.ne]: 2 } },
    };
    const target: AccessFilterReadGrant = {
      identity: { ...projectIdentity },
      fields: ['name'],
      where: { name: { [Op.ne]: 'Alpha' } },
    };
    grants.set('', root);
    grants.set('project', target);
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      request.attributes[0] = 'tenantId';
      request.filter.name.$ne = 'Owned';
      request.sort[0] = '-amount';
      source.collectionKey = 'wrong';
      authenticated.tenantId = 'C';
      root.fields = ['tenantId'];
      root.where = {};
      target.where = {};
      return original(...args);
    });
    expect(await reads.list(ctx, source, authenticated, request)).toEqual([{ id: 1 }, { id: 4 }]);
    expect(resolver.mock.calls.filter(([, path]) => path.length === 0)).toHaveLength(1);
    expect(resolver.mock.calls.filter(([, path]) => path.join('.') === 'project')).toHaveLength(1);
  });
  it('rejects changes to sort-only relation metadata during filter compilation', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      Object.assign(docs.model.associations.project, { scope: { name: 'Secret' } });
      return result;
    });
    await expect(list({ sort: ['project.name'] })).rejects.toThrow(/changed/);
  });
  it('rejects ended phases after the actual database read instead of returning stale results', async () => {
    const original = docs.model.findAll.bind(docs.model);
    vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      adapter.release(ctx);
      return result;
    });
    await expect(list()).rejects.toThrow();
  });
  it.each(['get', 'count', 'sum'] as const)('checks the phase after executing %s', async (kind) => {
    const query = db.sequelize.query.bind(db.sequelize);
    vi.spyOn(db.sequelize, 'query').mockImplementation(async (...args) => {
      const result = await query(...args);
      if (String(args[0]).includes('read_documents')) adapter.release(ctx);
      return result;
    });
    await expect(kind === 'get' ? get(1) : kind === 'count' ? count() : sum()).rejects.toThrow();
  });
  it('rejects foreign, finished and fake transactions before reading records', async () => {
    const foreign = sqliteDatabase();
    const foreignTransaction = await foreign.sequelize.transaction();
    const finished = await db.sequelize.transaction();
    await finished.rollback();
    const find = vi.spyOn(docs.model, 'findAll');
    try {
      for (const transaction of [{}, foreignTransaction, finished])
        await expect(list({ transaction })).rejects.toThrow(/transaction/i);
      expect(find).not.toHaveBeenCalled();
    } finally {
      await foreignTransaction.rollback();
      await foreign.close();
    }
  });
  it('passes the execution transaction and bypasses ORM query hooks', async () => {
    const hook = vi.fn(() => {
      throw new Error('unexpected ORM hook');
    });
    docs.model.addHook('beforeFind', 'read-test', hook);
    docs.model.addHook('beforeCount', 'count-test', hook);
    const transaction = await db.sequelize.transaction();
    try {
      await docs.model.create({ id: 9, tenantId: 'B', name: 'Uncommitted', amount: 90 }, { transaction });
      expect(await list({ filter: { id: 9 }, transaction })).toEqual([{ id: 9 }]);
      expect(await reads.count(ctx, mainIdentity, auth, { filter: { id: 9 }, transaction })).toBe(1);
      expect(await reads.sum(ctx, mainIdentity, auth, { field: 'amount', filter: { id: 9 }, transaction })).toBe(90);
      expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter: { id: 9 } }, transaction)).toBe(1);
      expect(
        await entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter: { id: 9 } }, transaction),
      ).toBe(90);
      expect(
        await entryReads.fromResource(
          ctx,
          auth,
          { resourceName: 'documents', actionName: 'count' },
          { filter: { id: 9 } },
          transaction,
        ),
      ).toBe(1);
      expect(
        await entryReads.fromResource(
          ctx,
          auth,
          { resourceName: 'documents', actionName: 'get' },
          { filterByTk: 9, fields: ['id'] },
          transaction,
        ),
      ).toEqual({ id: 9 });
      expect(hook).not.toHaveBeenCalled();
    } finally {
      await transaction.rollback();
    }
    expect(await get(9)).toBeNull();
  });
  it('keeps SQL query count constant for 20 and 100 root rows', async () => {
    await docs.model.bulkCreate(
      Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, tenantId: 'B', name: 'More', projectId: 101 })),
    );
    const query = vi.spyOn(db.sequelize, 'query');
    const run = async (limit: number) => {
      query.mockClear();
      expect(await list({ sort: ['project.name'], limit })).toHaveLength(limit);
      return query.mock.calls.length;
    };
    expect(await run(20)).toBe(await run(100));
    expect(await list()).toHaveLength(20);
  });
});
