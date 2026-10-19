import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessEntryReadService, type AccessEntryReadOperation } from './entry-reads';
import type { AccessQueryService } from './query';
import type { AccessReadDateContext } from './read-date-filter';
import { collectRelatedReadPaths } from './read-paths';
import { prepareRelatedReadContexts, type AccessRelatedReadAuthorizer } from './related-read-contexts';
import { resolveResourceReadRoute } from './resource-read-routing';
import { captureRelatedReadPermission, captureRootReadContext, type AccessRootReadContext } from './root-read-context';
import { invalid } from './write-support';

export type { AccessRootReadContext } from './root-read-context';

/** Server-finalized, unfiltered target list context for this exact request/path; never client input. */
export type AccessRelatedReadContextResolver = (
  collection: Collection,
  path: readonly string[],
  operation: AccessEntryReadOperation,
) => AccessRootReadContext | null;

/**
 * Internal handler for prepared root list/get/count actions after the complete core ACL chain.
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

  /** The authorizer returns existing finalized target decisions; it never receives merged user params. */
  async handleWithRelatedContexts(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorize: AccessRelatedReadAuthorizer,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    const captured = captureRootReadContext(this.db, ctx, authenticated, dates);
    if (!captured.permission.allowed) invalid('Root read is not authorized');
    const root = resolveResourceReadRoute(this.db, this.resolveIdentity, captured.action);
    const config = this.prepared.configuration(ctx, root.identity);
    if (!config) invalid('Root reads require a prepared access configuration');
    const assertCurrent = () => {
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
      captured.params,
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
    await this.execute(ctx, captured, related, transaction);
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
  ) {
    const { action, identity, roleName, permission, params, dateContext } = captured;
    const reads = new AccessEntryReadService(
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
    const body = await reads.fromResource(ctx, identity, action, params, transaction, dateContext);
    ctx.body = body;
    if (action.actionName === 'list') ctx.paginate = true;
  }
}
