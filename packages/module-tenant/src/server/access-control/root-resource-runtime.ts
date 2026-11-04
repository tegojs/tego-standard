import {
  columns2Appends,
  ExportColumnsError,
  filterExportColumnsByCollection,
  normalizeExportColumns,
} from '@tachybase/plugin-action-export';
import { Resourcer, type Collection, type Context, type Database, type Next } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { AccessChartQueryHandler } from './chart-query-handler';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureFinalActionPermission } from './final-action-permission';
import { assertLegacyChartReadBoundary, assertLegacyReadBoundary } from './legacy-read-boundary';
import { assertLegacyWriteBoundary } from './legacy-write-boundary';
import { preserveAccessResourceAction } from './preserved-resource-action';
import { AccessQueryService } from './query';
import { AccessResourceMutationHandler } from './resource-mutation-handler';
import type { AccessRootReadContext } from './root-read-context';
import { AccessRootReadHandler } from './root-read-handler';
import { cloneDeep, invalid, plain } from './write-support';

interface RootRequest {
  resourceName: string;
  actionName: string;
  sourceId: unknown;
  actor: Readonly<AccessIdentity>;
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

  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
    resolveCollectionKey: (collection: Collection) => string,
    private readonly finalizeRelated: (ctx: Context, next: Next) => Promise<unknown>,
  ) {
    const queries = new AccessQueryService(db, prepared, resolveCollectionKey);
    this.reader = new AccessRootReadHandler(db, prepared, queries, resolveIdentity);
    this.writer = new AccessResourceMutationHandler(db, prepared, queries, resolveIdentity);
    this.charts = new AccessChartQueryHandler(db, this.reader, resolveIdentity);
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
    const legacyWrite = ['create', 'update'].includes(actionName);
    const legacyAction = chart || legacyWrite || ['list', 'get', 'count', 'export'].includes(actionName);
    if (!selected.length && (!collection || !legacyAction)) return void (await next());
    const capturedActor = Object.freeze({ tenantId: actor.tenantId, userId: actor.userId, roleName: actor.roleName });
    const capturedIdentities = identities.map((value) => ({ ...value }));
    await this.prepared.withPrepared(ctx, capturedIdentities, async () => {
      const configured = selected.filter((identity) => this.prepared.configuration(ctx, identity));
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
    const authorize = async (collection: Collection, actionName: string): Promise<AccessRootReadContext> => {
      request.assertCurrent();
      const decision = this.relatedDecision(ctx, collection, actionName);
      request.related.push(decision);
      await this.prepared.prepare(decision, request.identities);
      await this.finalizeRelated(decision as unknown as Context, async () => {});
      request.assertCurrent();
      return decision;
    };
    const authorizeRead = (collection: Collection) => authorize(collection, 'list');
    const context = ctx as unknown as AccessRootReadContext;
    if (request.resourceName === 'charts' && request.actionName === 'query')
      await this.charts.handle(context, request.actor, { source: authorizeRead, related: authorizeRead });
    else if (['list', 'get', 'count'].includes(request.actionName))
      await this.reader.handleResourceWithRelatedContexts(context, request.actor, authorizeRead);
    else if (request.actionName === 'export')
      await this.reader.handleExportWithRelatedContexts(
        context as AccessRootReadContext & Context,
        request.actor,
        authorizeRead,
      );
    else if (['create', 'update', 'destroy', 'add', 'remove', 'set'].includes(request.actionName))
      await this.writer.handle(context, request.actor, {
        read: authorizeRead,
        update: (collection) => authorize(collection, 'update'),
        source: (collection, operation) => authorize(collection, operation),
      });
    else invalid('Selected root action requires a dedicated runtime adapter');
    request.assertCurrent();
  }
}
