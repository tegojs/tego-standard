import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { prepareAssociationReadContexts } from './association-read-contexts';
import { parseChartQueryParams } from './chart-query-params';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessEntryReadService, type AccessEntryReadOperation } from './entry-reads';
import type { AccessQueryService } from './query';
import type { AccessReadDateContext } from './read-date-filter';
import { collectRelatedReadPaths } from './read-paths';
import { prepareRelatedReadContexts, type AccessRelatedReadAuthorizer } from './related-read-contexts';
import { resolveResourceReadRoute } from './resource-read-routing';
import {
  captureAssociationReadContext,
  capturePlaceholderReadContext,
  captureRelatedReadPermission,
  captureRootReadContext,
  type AccessRootReadContext,
} from './root-read-context';
import { cloneDeep, invalid } from './write-support';

export type { AccessRootReadContext } from './root-read-context';

/** Server-finalized, unfiltered target list context for this exact request/path; never client input. */
export type AccessRelatedReadContextResolver = (
  collection: Collection,
  path: readonly string[],
  operation: AccessEntryReadOperation,
) => AccessRootReadContext | null;

/**
 * Internal handler for root reads and charts after the complete collection ACL chain.
 * No routes are registered here. The caller supplies authenticated identity and date context.
 */
export class AccessRootReadHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
    private readonly resolveRelatedContext?: AccessRelatedReadContextResolver,
  ) {}

  /** Concrete sources and targets retain separate finalized ACL decisions and G/V scopes. */
  async handleAssociation(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    sourceContext: AccessRootReadContext,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    await this.executeAssociation(ctx, authenticated, sourceContext, transaction, dates);
  }

  /** Await only the through/nested decisions used by this concrete association operation. */
  async handleAssociationWithRelatedContexts(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    sourceContext: AccessRootReadContext,
    authorize: AccessRelatedReadAuthorizer,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    await this.executeAssociation(ctx, authenticated, sourceContext, transaction, dates, authorize);
  }

  private async executeAssociation(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    sourceContext: AccessRootReadContext,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
    authorize?: AccessRelatedReadAuthorizer,
  ) {
    // Capture the neutral source decision before any collection metadata callback can change it.
    const source = captureRootReadContext(this.db, sourceContext, authenticated, dates);
    if (source.action.actionName !== 'list' || Reflect.ownKeys(source.params).length || !source.permission.allowed)
      invalid('Association reads require a neutral authorized source list context');
    const plan = captureAssociationReadContext(this.db, this.resolveIdentity, ctx, source.identity, source.dateContext);
    const { captured, sourceCollection, targetCollection, relation } = plan;
    if (source.action.resourceName !== sourceCollection.name || !captured.permission.allowed)
      invalid('Association source or target read is not authorized');
    const config = this.prepared.configuration(ctx, plan.identity);
    const assertCurrent = () => {
      plan.assertCurrent();
      if (this.prepared.configuration(ctx, plan.identity) !== config)
        invalid('Association read preparation phase changed');
    };
    const preparation = authorize
      ? await prepareAssociationReadContexts(
          this.db,
          this.prepared,
          this.queries,
          this.resolveIdentity,
          ctx,
          plan,
          authorize,
          assertCurrent,
        )
      : undefined;
    const related = preparation?.related ?? this.resolveRelatedContext;
    const assertReady = preparation?.assertCurrent ?? assertCurrent;
    const reader = new AccessEntryReadService(
      this.db,
      this.prepared,
      this.queries,
      this.resolveIdentity,
      (collection, path, operation) => {
        assertReady();
        if (!path.length) {
          if (collection !== sourceCollection) invalid('Association source permission target changed');
          return source.permission;
        }
        if (path.length === 1 && path[0] === relation) {
          if (collection !== targetCollection) invalid('Association target permission changed');
          return captured.permission;
        }
        const context = related?.(collection, Object.freeze([...path]), operation);
        const permission =
          context == null ? null : captureRelatedReadPermission(this.db, collection, captured.roleName, context);
        assertReady();
        return permission;
      },
    );
    assertReady();
    const body = await reader.fromResource(
      ctx,
      captured.identity,
      plan.action,
      captured.params,
      transaction,
      captured.dateContext,
    );
    assertReady();
    ctx.body = body;
    if (plan.action.actionName === 'list') ctx.paginate = true;
  }

  /** Association placeholders retain target ACL constraints and reuse the direct read pipeline. */
  async handlePlaceholderWithRelatedContexts(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorize: AccessRelatedReadAuthorizer,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    const { captured, assertCurrent } = capturePlaceholderReadContext(
      this.db,
      this.resolveIdentity,
      ctx,
      authenticated,
      dates,
    );
    const preparation = await this.prepareRelated(ctx, captured, authorize, captured.params, undefined, assertCurrent);
    preparation.assertCurrent();
    await this.execute(ctx, captured, preparation.related, transaction, preparation.assertCurrent);
  }

  /** The authorizer returns existing finalized target decisions; it never receives merged user params. */
  async handleWithRelatedContexts(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorize: AccessRelatedReadAuthorizer,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    const captured = captureRootReadContext(this.db, ctx, authenticated, dates);
    const preparation = await this.prepareRelated(ctx, captured, authorize);
    preparation.assertCurrent();
    await this.execute(ctx, captured, preparation.related, transaction);
  }

  /** Charts require a neutral finalized collection list decision, not the chart resource decision. */
  async handleChartWithRelatedContexts(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    values: unknown,
    authorize: AccessRelatedReadAuthorizer,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    const captured = captureRootReadContext(this.db, ctx, authenticated, dates);
    if (captured.action.actionName !== 'list' || Reflect.ownKeys(captured.params).length)
      invalid('Chart reads require an unfiltered collection list context');
    const request = parseChartQueryParams(values);
    if (request.collection !== captured.action.resourceName)
      invalid('Chart query does not match the authorized collection');
    // Validate first, then clone: copying must not normalize invalid request prototypes.
    const query = cloneDeep(values);
    const preparation = await this.prepareRelated(
      ctx,
      captured,
      authorize,
      { filter: request.chart.filter },
      request.dataSource,
    );
    preparation.assertCurrent();
    const body = await this.reader(captured, preparation.related).chartFromQuery(
      ctx,
      captured.identity,
      query,
      transaction,
      captured.dateContext,
    );
    ctx.body = body;
  }

  private async prepareRelated(
    ctx: AccessRootReadContext,
    captured: ReturnType<typeof captureRootReadContext>,
    authorize: AccessRelatedReadAuthorizer,
    params: unknown = captured.params,
    dataSource?: string,
    assertRoute?: () => void,
  ) {
    if (!captured.permission.allowed) invalid('Root read is not authorized');
    const root = resolveResourceReadRoute(this.db, this.resolveIdentity, captured.action);
    if (dataSource !== undefined && root.identity.dataSourceKey !== dataSource)
      invalid('Chart query data source does not match the registered collection identity');
    const config = this.prepared.configuration(ctx, root.identity);
    if (!config) invalid('Root reads require a prepared access configuration');
    const assertCurrent = () => {
      assertRoute?.();
      root.assertCurrent();
      if (this.prepared.configuration(ctx, root.identity) !== config) invalid('Root read preparation phase changed');
    };
    const operation: AccessEntryReadOperation = Object.freeze({
      kind: captured.action.actionName,
      context: ctx,
      source: root.identity,
      authenticated: captured.identity,
    });
    const paths = collectRelatedReadPaths(
      this.db,
      this.prepared,
      this.queries,
      this.resolveIdentity,
      operation,
      params,
      captured.dateContext,
    );
    assertCurrent();
    const related = await prepareRelatedReadContexts(
      this.db,
      this.resolveIdentity,
      operation,
      paths,
      async (...args) => {
        assertCurrent();
        const related = await authorize(...args);
        assertCurrent();
        return related;
      },
    );
    assertCurrent();
    return { related, assertCurrent };
  }

  async handle(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    await this.execute(
      ctx,
      captureRootReadContext(this.db, ctx, authenticated, dates),
      this.resolveRelatedContext,
      transaction,
    );
  }

  private async execute(
    ctx: AccessRootReadContext,
    captured: ReturnType<typeof captureRootReadContext>,
    related: AccessRelatedReadContextResolver | undefined,
    transaction?: Transaction,
    assertCurrent?: () => void,
  ) {
    assertCurrent?.();
    const { action, identity, params, dateContext } = captured;
    const body = await this.reader(captured, related).fromResource(
      ctx,
      identity,
      action,
      params,
      transaction,
      dateContext,
    );
    assertCurrent?.();
    ctx.body = body;
    if (action.actionName === 'list') ctx.paginate = true;
  }

  private reader(
    captured: ReturnType<typeof captureRootReadContext>,
    related: AccessRelatedReadContextResolver | undefined,
  ) {
    const { roleName, permission } = captured;
    return new AccessEntryReadService(
      this.db,
      this.prepared,
      this.queries,
      this.resolveIdentity,
      (collection, path, operation) => {
        if (path.length === 0) return permission;
        const context = related?.(collection, Object.freeze([...path]), operation);
        if (context == null) return null;
        return captureRelatedReadPermission(this.db, collection, roleName, context);
      },
    );
  }
}
