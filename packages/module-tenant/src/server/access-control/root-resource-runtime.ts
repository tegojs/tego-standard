import {
  columns2Appends,
  ExportColumnsError,
  filterExportColumnsByCollection,
  normalizeExportColumns,
} from '@tachybase/plugin-action-export';
import {
  NoPermissionError,
  Repository,
  Resourcer,
  type Collection,
  type Context,
  type Database,
  type Next,
} from '@tego/server';

import { translateTenantError } from '../locale';
import type { AccessAclScopeAdapter } from './acl-scope';
import { AccessChartQueryHandler } from './chart-query-handler';
import type { AccessCollectionIdentity } from './config-store';
import { requiresTenantAccessContext, type AccessIdentity } from './context';
import { dateFilterOperators } from './date-filter';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission } from './final-action-permission';
import { assertLegacyChartReadBoundary, assertLegacyReadBoundary } from './legacy-read-boundary';
import { assertLegacyDestroyBoundary, assertLegacyWriteBoundary } from './legacy-write-boundary';
import { preserveAccessResourceAction } from './preserved-resource-action';
import { AccessQueryService } from './query';
import type { AccessReadDateContext } from './read-date-filter';
import { AccessResourceMutationHandler } from './resource-mutation-handler';
import { appendRootActionMeta } from './root-action-meta';
import { AccessRootImportHandler } from './root-import-handler';
import type { AccessRootReadContext } from './root-read-context';
import { AccessRootReadHandler } from './root-read-handler';
import { cloneDeep, invalid, plain } from './write-support';

interface RootRequest {
  resourceName: string;
  actionName: string;
  sourceId: unknown;
  actor: Readonly<AccessIdentity>;
  dates: Readonly<AccessReadDateContext>;
  requiresTenant: boolean;
  identities: readonly AccessCollectionIdentity[];
  related: AccessRootReadContext[];
  assertCurrent(): void;
}

/** Explicit root-resource composition. The tenant plugin does not install this runtime. */
export class AccessRootResourceRuntime {
  private readonly requests = new WeakMap<object, RootRequest>();
  private readonly legacyChecks = new WeakMap<object, () => void | Promise<void>>();
  private readonly reader: AccessRootReadHandler;
  private readonly writer: AccessResourceMutationHandler;
  private readonly charts: AccessChartQueryHandler;
  private readonly importer: AccessRootImportHandler;
  private readonly queries: AccessQueryService;

  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
    resolveCollectionKey: (collection: Collection) => string,
    private readonly finalizeRelated: (ctx: Context, next: Next) => Promise<unknown>,
  ) {
    const queries = (this.queries = new AccessQueryService(db, prepared, resolveCollectionKey));
    this.reader = new AccessRootReadHandler(db, prepared, queries, resolveIdentity);
    this.writer = new AccessResourceMutationHandler(db, prepared, queries, resolveIdentity);
    this.charts = new AccessChartQueryHandler(db, this.reader, resolveIdentity);
    this.importer = new AccessRootImportHandler(db, prepared, queries, resolveIdentity);
  }

  private relatedDecision(ctx: Context, collection: Collection, actionName: string) {
    const resourcer = new Resourcer();
    resourcer.define({ name: collection.name, actions: { [actionName]: {} } });
    const action = resourcer.getAction(collection.name, actionName).clone();
    Object.assign(action, { resourceName: collection.name, actionName });
    action.mergeParams({ resourceName: collection.name, actionName, filterByTk: undefined });
    return {
      db: this.db,
      action,
      permission: undefined as unknown,
      state: ctx.state,
      get: ctx.get.bind(ctx),
      logger: ctx.logger,
      throw: ctx.throw.bind(ctx),
    };
  }

  private readDates(ctx: Context, dates: Readonly<AccessReadDateContext>) {
    const raw = plain(ctx.permission) ? Object.getOwnPropertyDescriptor(ctx.permission, 'rawParams')?.value : undefined;
    const filter = plain(raw) ? Object.getOwnPropertyDescriptor(raw, 'filter')?.value : undefined;
    const hasDate = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(hasDate);
      if (!plain(value)) return false;
      return Object.entries(value).some(
        ([key, child]) => (dateFilterOperators as readonly string[]).includes(key.split('.').at(-1)!) || hasDate(child),
      );
    };
    // A timezone is relevant only to calendar predicates; scalar-only requests retain their existing behavior.
    // 仅日历条件需要时区，普通标量请求保持原有行为。
    return hasDate(captureAccessFilter(filter === undefined ? {} : filter)) ? dates : undefined;
  }

  /** Wrap the existing ACL middleware, after server authentication and tenant selection. */
  async prepare(
    ctx: Context,
    actor: AccessIdentity,
    identities: readonly AccessCollectionIdentity[],
    next: Next,
  ): Promise<void> {
    if (ctx.db !== this.db || this.requests.has(ctx)) invalid('Invalid root resource request phase');
    const { resourceName, actionName, sourceId } = ctx.action;
    const parts = resourceName?.split('.') ?? [];
    const chart = resourceName === 'charts' && actionName === 'query';
    const chartValues = chart ? Object.getOwnPropertyDescriptor(ctx.action.params, 'values')?.value : undefined;
    const values = chart ? (chartValues === undefined ? ctx.action.params : chartValues) : undefined;
    const chartSource = plain(values) ? Object.getOwnPropertyDescriptor(values, 'dataSource')?.value : undefined;
    const chartCollection = plain(values) ? Object.getOwnPropertyDescriptor(values, 'collection')?.value : undefined;
    const chartDatabase =
      typeof chartSource === 'string'
        ? ctx.tego?.dataSourceManager?.dataSources.get(chartSource)?.collectionManager?.db
        : undefined;
    const collection = chart
      ? typeof chartCollection === 'string' && (!chartDatabase || chartDatabase === this.db)
        ? this.db.getCollection(chartCollection)
        : undefined
      : this.db.getCollection(parts[0]);
    const targetName = !chart && parts.length === 2 ? collection?.getField(parts[1])?.target : undefined;
    const target = targetName ? this.db.getCollection(targetName) : undefined;
    const selected = [collection, target]
      .filter((value): value is Collection => !!value)
      .map((value) => this.resolveIdentity(value))
      .filter((value): value is AccessCollectionIdentity => !!value)
      .map((value) => ({ ...value }));
    const legacyUpsert = ['firstOrCreate', 'updateOrCreate'].includes(actionName);
    const legacyWrite = legacyUpsert || ['create', 'update'].includes(actionName);
    const legacyLink = parts.length === 2 && ['add', 'remove', 'set', 'toggle'].includes(actionName);
    const legacyDestroy = actionName === 'destroy';
    const legacyMove = actionName === 'move';
    const legacyImport = actionName === 'importXlsx';
    const legacyAction =
      chart ||
      legacyWrite ||
      legacyLink ||
      legacyDestroy ||
      legacyMove ||
      legacyImport ||
      ['list', 'get', 'count', 'export'].includes(actionName);
    if (!selected.length && (!collection || !legacyAction)) return void (await next());
    const capturedActor = Object.freeze({ tenantId: actor.tenantId, userId: actor.userId, roleName: actor.roleName });
    const capturedDates = Object.freeze({ now: new Date().toISOString(), timezone: ctx.get('x-timezone') || '+00:00' });
    const capturedIdentities = identities.map((value) => ({ ...value }));
    await this.prepared.withPrepared(ctx, capturedIdentities, async () => {
      const configured: AccessCollectionIdentity[] = [];
      for (const identity of selected) {
        const config = this.prepared.configuration(ctx, identity);
        if (!config) continue;
        const selectedCollection = this.db.getCollection(identity.collectionName);
        if (!selectedCollection) invalid('Selected collection is unavailable');
        const tenancy = selectedCollection.options.tenancy;
        if ((tenancy === 'tenantScoped' || tenancy === 'tenantInherited') && !config.ownership.enabled)
          invalid('Selected tenant collections must enforce ownership');
        configured.push(identity);
      }
      if (!configured.length) {
        if (!legacyAction) return void (await next());
        if (!capturedIdentities.some((identity) => this.prepared.configuration(ctx, identity)))
          return void (await next());
        const legacyCollection = target ?? collection;
        const model = legacyCollection.model;
        const assertCurrent = () => {
          if (
            ctx.db !== this.db ||
            (chart &&
              (ctx.action.resourceName !== resourceName ||
                ctx.action.actionName !== actionName ||
                ctx.action.sourceId !== sourceId)) ||
            this.db.getCollection(legacyCollection.name) !== legacyCollection ||
            legacyCollection.model !== model
          )
            invalid('Legacy read collection changed');
        };
        this.legacyChecks.set(ctx, async () => {
          assertCurrent();
          const protectedCollection = (collection: Collection) => {
            const identity = this.resolveIdentity(collection);
            return !!identity && !!this.prepared.configuration(ctx, identity);
          };
          if (chart)
            assertLegacyChartReadBoundary(this.db, legacyCollection, ctx.action.params, protectedCollection, ctx);
          else assertLegacyReadBoundary(this.db, legacyCollection, ctx.action.params, protectedCollection, ctx);
          // The original root-role chart branch does not add a source list filter.
          if (chart && capturedActor.roleName !== 'root') {
            if (typeof capturedActor.roleName !== 'string') invalid('Legacy chart role is unavailable');
            const decision = this.relatedDecision(ctx, legacyCollection, 'list');
            // This source uses the legacy mechanism: no selected configuration or delegation is prepared for it.
            await this.finalizeRelated(decision as unknown as Context, async () => {});
            assertCurrent();
            const permission = captureFinalActionPermission(decision.permission, {
              resourceName: legacyCollection.name,
              actionName: 'list',
              roleName: capturedActor.roleName,
            });
            if (!permission.allowed) invalid('Legacy chart source list permission is unavailable');
            assertLegacyReadBoundary(this.db, legacyCollection, decision.action.params, protectedCollection, ctx);
          }
          if (actionName === 'export') {
            const params = cloneDeep(ctx.action.params);
            try {
              const columns = filterExportColumnsByCollection(
                normalizeExportColumns(params.values?.columns ?? params.columns),
                legacyCollection,
              );
              const appends = columns2Appends(columns, ctx);
              assertLegacyReadBoundary(this.db, legacyCollection, { appends }, protectedCollection, ctx);
            } catch (error) {
              if (error instanceof ExportColumnsError) invalid(error.message);
              throw error;
            }
          }
          if (legacyWrite) assertLegacyWriteBoundary(this.db, legacyCollection, ctx.action.params, protectedCollection);
          if (actionName === 'create')
            for (const field of legacyCollection.getFields()) {
              const name = field.options.targetField;
              if (field.type !== 'snapshot' || !legacyCollection.hasField(name)) continue;
              const association = legacyCollection.model.associations[name];
              const target = association && this.db.modelCollection.get(association.target);
              if (!target) continue;
              // Snapshot fields read after insertion, including relationships supplied only by defaults.
              const appends = (field.options.appends || []).filter((append: string) =>
                this.db.getFieldByPath(`${target.name}.${append}`),
              );
              assertLegacyReadBoundary(
                this.db,
                legacyCollection,
                { appends: [name, ...appends.map((append: string) => `${name}.${append}`)] },
                protectedCollection,
                ctx,
              );
            }
          if (legacyLink)
            assertLegacyWriteBoundary(this.db, collection, { values: { [parts[1]]: null } }, protectedCollection);
          if (legacyDestroy) assertLegacyDestroyBoundary(this.db, legacyCollection, protectedCollection);
          if (legacyMove) {
            const params = ctx.action.params;
            const association = parts.length === 2 ? collection.model.associations[parts[1]] : undefined;
            const sortName =
              association?.associationType === 'HasMany'
                ? `${(association as typeof association & { foreignKey: string }).foreignKey}Sort`
                : (params.sortField ?? 'sort');
            const field = legacyCollection.getField(sortName);
            const scopeKey = field?.type === 'sort' ? field.options.scopeKey : undefined;
            const scope = typeof scopeKey === 'string' ? params.targetScope?.[scopeKey] : undefined;
            // Moving between records can also copy the destination record's scope key.
            if (
              params.sourceId &&
              typeof scopeKey === 'string' &&
              (params.targetId || (scope !== undefined && scope !== null && scope !== ''))
            )
              assertLegacyWriteBoundary(
                this.db,
                legacyCollection,
                { values: { [scopeKey]: null } },
                protectedCollection,
              );
          }
          if (legacyUpsert) {
            const params = cloneDeep(ctx.action.params);
            const filter = Repository.valuesToFilter(params.values, params.filterKeys);
            assertLegacyReadBoundary(this.db, legacyCollection, { filter }, protectedCollection, ctx);
          }
          if (legacyImport) {
            const upload = ctx.request as typeof ctx.request & { body?: { columns?: unknown } };
            let columns = cloneDeep(upload.body?.columns);
            if (typeof columns === 'string') {
              try {
                columns = JSON.parse(columns);
              } catch {
                invalid('Legacy import columns must contain valid JSON');
              }
            }
            if (!Array.isArray(columns)) invalid('Legacy import columns must be an array');
            const values = Object.create(null);
            const fields: string[] = [];
            for (const column of columns) {
              if (
                !plain(column) ||
                !Array.isArray(column.dataIndex) ||
                !column.dataIndex.length ||
                column.dataIndex.some((part) => typeof part !== 'string')
              )
                invalid('Invalid legacy import field path');
              // The original importer ignores columns without a registered source field.
              if (!legacyCollection.getField(column.dataIndex[0])) continue;
              values[column.dataIndex[0]] = null;
              fields.push(column.dataIndex.join('.'));
            }
            assertLegacyWriteBoundary(this.db, legacyCollection, { values }, protectedCollection);
            assertLegacyReadBoundary(this.db, legacyCollection, { fields }, protectedCollection, ctx);
          }
        });
        try {
          await next();
        } finally {
          this.legacyChecks.delete(ctx);
        }
        return;
      }
      if (
        (parts.length !== 1 || sourceId !== undefined) &&
        !(parts.length === 2 && ['list', 'get', 'count', 'export', 'add', 'remove', 'set'].includes(actionName))
      )
        invalid('Selected association resources require a dedicated runtime adapter');
      const identity = configured[0];
      const config = this.prepared.configuration(ctx, identity);
      const model = collection.model;
      const request: RootRequest = {
        resourceName,
        actionName,
        sourceId,
        actor: capturedActor,
        dates: capturedDates,
        requiresTenant: configured.some((identity) => {
          const config = this.prepared.configuration(ctx, identity);
          return config.ownership.enabled || requiresTenantAccessContext(config);
        }),
        identities: capturedIdentities,
        related: [],
        assertCurrent: () => {
          if (
            this.requests.get(ctx) !== request ||
            ctx.db !== this.db ||
            ctx.action.resourceName !== resourceName ||
            ctx.action.actionName !== actionName ||
            ctx.action.sourceId !== sourceId ||
            this.db.getCollection(collection.name) !== collection ||
            collection.model !== model ||
            this.prepared.configuration(ctx, identity) !== config
          )
            invalid('Root resource request phase has changed');
        },
      };
      this.requests.set(ctx, request);
      const releaseAction = preserveAccessResourceAction(ctx);
      try {
        await next();
        request.assertCurrent();
      } finally {
        releaseAction();
        this.requests.delete(ctx);
        for (const context of request.related) this.prepared.release(context);
      }
    });
  }

  /** Run after the existing ACL chain, before the legacy tenant guard and default action. */
  async dispatch(ctx: Context, next: Next): Promise<void> {
    const legacyCheck = this.legacyChecks.get(ctx);
    if (legacyCheck) {
      await legacyCheck();
      return void (await next());
    }
    const request = this.requests.get(ctx);
    if (!request) return void (await next());
    request.assertCurrent();
    // Selected dispatch runs before the legacy tenant guard; retain its actionable missing-tenant denial.
    // 选中执行链位于旧租户守卫之前，仍须保留明确的缺租户拒绝提示。
    if (request.requiresTenant && (request.actor.tenantId == null || request.actor.tenantId === ''))
      ctx.throw(403, translateTenantError(ctx, 'tenantContextRequired'));
    const authorize = async (
      collection: Collection,
      actionName: string,
      metadata = false,
    ): Promise<AccessRootReadContext> => {
      request.assertCurrent();
      const decision = this.relatedDecision(ctx, collection, actionName);
      request.related.push(decision);
      await this.prepared.prepare(decision, request.identities);
      let denied: NoPermissionError | undefined;
      if (metadata)
        decision.throw = (status, ...args) => {
          const error = new NoPermissionError(...args);
          if (status === 403) denied = error;
          throw error;
        };
      try {
        await this.finalizeRelated(decision as unknown as Context, async () => {});
      } catch (error) {
        // Only an explicit absent action grant becomes an empty hint, never a failed allowed decision.
        if (
          !metadata ||
          denied === undefined ||
          error !== denied ||
          !plain(decision.permission) ||
          (decision.permission.can !== null &&
            decision.permission.can !== false &&
            decision.permission.can !== undefined) ||
          decision.permission.skip === true
        )
          throw error;
      }
      request.assertCurrent();
      return decision;
    };
    const authorizeRead = (collection: Collection) => authorize(collection, 'list');
    const context = ctx as unknown as AccessRootReadContext;
    if (request.resourceName === 'charts' && request.actionName === 'query')
      await this.charts.handle(context, request.actor, { source: authorizeRead, related: authorizeRead });
    else if (['list', 'get', 'count'].includes(request.actionName))
      await this.reader.handleResourceWithRelatedContexts(
        context,
        request.actor,
        authorizeRead,
        undefined,
        this.readDates(ctx, request.dates),
      );
    else if (request.actionName === 'export')
      await this.reader.handleExportWithRelatedContexts(
        context as AccessRootReadContext & Context,
        request.actor,
        authorizeRead,
      );
    else if (request.actionName === 'importXlsx') {
      const upload = ctx.request as typeof ctx.request & { body?: { columns?: unknown } };
      await this.importer.handle(
        context,
        request.actor,
        { buffer: ctx.file?.buffer, columns: upload.body?.columns },
        authorizeRead,
      );
    } else if (['create', 'update', 'destroy', 'add', 'remove', 'set'].includes(request.actionName))
      await this.writer.handle(context, request.actor, {
        read: authorizeRead,
        update: (collection) => authorize(collection, 'update'),
        source: (collection, operation) => authorize(collection, operation),
      });
    else invalid('Selected root action requires a dedicated runtime adapter');
    request.assertCurrent();
    await appendRootActionMeta(
      this.db,
      this.prepared,
      this.queries,
      this.resolveIdentity,
      ctx,
      request.actor,
      (collection, action) => authorize(collection, action, true),
      request.assertCurrent,
    );
  }
}
