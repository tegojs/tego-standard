import { renderExportXlsxRows, type ExportXlsxRenderContext } from '@tachybase/plugin-action-export';
import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { captureAssociationReadPreparation, prepareAssociationReadContexts } from './association-read-contexts';
import { captureAttachmentRead } from './attachment-read-entry';
import { parseChartQueryParams } from './chart-query-params';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessEntryReadService, type AccessEntryReadOperation } from './entry-reads';
import type { AccessQueryService } from './query';
import type { AccessReadDateContext } from './read-date-filter';
import { collectRelatedReadPaths } from './read-paths';
import { captureReadPermissionMetadata, captureReadPreparationMetadata } from './read-preparation-metadata';
import { prepareRelatedReadContexts, type AccessRelatedReadAuthorizer } from './related-read-contexts';
import { resolveResourceReadRoute } from './resource-read-routing';
import {
  captureAssociationReadContext,
  captureExportReadContext,
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

  /** Final download ACL and record G/V only; trusted content adapters still own storage and streaming. */
  captureAttachment(ctx: AccessRootReadContext, authenticated: AccessIdentity) {
    return captureAttachmentRead(this.db, this.prepared, this.queries, this.resolveIdentity, ctx, authenticated);
  }

  /** Route finalized reads without replacing the target's actual action decision. */
  async handleResourceWithRelatedContexts(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorize: AccessRelatedReadAuthorizer,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    if (ctx.db !== this.db || !ctx.action || typeof ctx.action !== 'object')
      invalid('Resource read does not match the resource database');
    const resource = Object.getOwnPropertyDescriptor(ctx.action, 'resourceName');
    if (!resource || !Object.hasOwn(resource, 'value') || typeof resource.value !== 'string')
      invalid('Resource reads require a resource name');
    if (!resource.value.includes('.')) {
      await this.handleWithRelatedContexts(ctx, authenticated, authorize, transaction, dates);
      return;
    }
    const sourceId = Object.getOwnPropertyDescriptor(ctx.action, 'sourceId');
    if (sourceId && !Object.hasOwn(sourceId, 'value')) invalid('Resource reads cannot contain source accessors');
    if (sourceId?.value === '_') {
      await this.handlePlaceholderWithRelatedContexts(ctx, authenticated, authorize, transaction, dates);
      return;
    }
    // Capture target input and identity before awaiting the independent source decision.
    const plan = captureAssociationReadContext(this.db, this.resolveIdentity, ctx, authenticated, dates);
    const { source, preparation } = await this.prepareAssociationSource(ctx, plan, authorize);
    await this.executeCapturedAssociation(ctx, source, plan, transaction, authorize, preparation);
  }

  private async prepareAssociationSource(
    ctx: AccessRootReadContext,
    plan: ReturnType<typeof captureAssociationReadContext>,
    authorize: AccessRelatedReadAuthorizer,
  ) {
    if (!plan.captured.permission.allowed) invalid('Association target read is not authorized');
    const preparation = captureAssociationReadPreparation(
      this.db,
      this.prepared,
      this.resolveIdentity,
      ctx,
      plan,
      plan.assertCurrent,
    );
    const { operation, assertCurrent } = preparation;
    assertCurrent();
    const sourceContext = await authorize(plan.sourceCollection, Object.freeze([]), operation);
    assertCurrent();
    if (sourceContext == null) invalid('Association reads require an authorized source context');
    const source = captureRootReadContext(this.db, sourceContext, plan.captured.identity, plan.captured.dateContext);
    if (source.action.actionName !== 'list' || Reflect.ownKeys(source.params).length || !source.permission.allowed)
      invalid('Association reads require a neutral authorized source list context');
    return { source, preparation };
  }

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
    await this.executeCapturedAssociation(ctx, source, plan, transaction, authorize);
  }

  private async executeCapturedAssociation(
    ctx: AccessRootReadContext,
    source: ReturnType<typeof captureRootReadContext>,
    plan: ReturnType<typeof captureAssociationReadContext>,
    transaction?: Transaction,
    authorize?: AccessRelatedReadAuthorizer,
    capturedPreparation?: ReturnType<typeof captureAssociationReadPreparation>,
  ) {
    const { body, assertCurrent } = await this.readCapturedAssociation(
      ctx,
      source,
      plan,
      transaction,
      authorize,
      capturedPreparation,
    );
    assertCurrent();
    ctx.body = body;
    if (plan.action.actionName === 'list') ctx.paginate = true;
  }

  private async readCapturedAssociation(
    ctx: AccessRootReadContext,
    source: ReturnType<typeof captureRootReadContext>,
    plan: ReturnType<typeof captureAssociationReadContext>,
    transaction?: Transaction,
    authorize?: AccessRelatedReadAuthorizer,
    capturedPreparation?: ReturnType<typeof captureAssociationReadPreparation>,
  ) {
    const assertEntryCurrent = capturedPreparation?.assertCurrent;
    assertEntryCurrent?.();
    const { captured, sourceCollection, targetCollection, relation } = plan;
    if (source.action.resourceName !== sourceCollection.name || !captured.permission.allowed)
      invalid('Association source or target read is not authorized');
    const config = this.prepared.configuration(ctx, plan.identity);
    const sourceRole = captureReadPermissionMetadata(this.db, this.resolveIdentity, plan.identity, source.permission);
    if (!sourceRole) invalid('Association source read is not authorized');
    const assertCurrent = () => {
      assertEntryCurrent?.();
      plan.assertCurrent();
      if (this.prepared.configuration(ctx, plan.identity) !== config)
        invalid('Association read preparation phase changed');
      sourceRole();
    };
    const preparation = authorize
      ? await prepareAssociationReadContexts(
          this.db,
          this.prepared,
          this.resolveIdentity,
          ctx,
          plan,
          authorize,
          assertCurrent,
          capturedPreparation,
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
    return { body, assertCurrent: assertReady };
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
    await this.execute(ctx, captured, preparation.related, transaction, preparation.assertCurrent);
  }

  /** Return authorized file inputs without cloning the prepared context or publishing an intermediate response. */
  async readExportWithRelatedContexts(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorize: AccessRelatedReadAuthorizer,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ) {
    const { captured, columns, title, assertCurrent, association } = captureExportReadContext(
      this.db,
      this.resolveIdentity,
      ctx,
      authenticated,
      dates,
    );
    if (association) {
      const { source, preparation } = await this.prepareAssociationSource(ctx, association, authorize);
      const result = await this.readCapturedAssociation(ctx, source, association, transaction, authorize, preparation);
      result.assertCurrent();
      if (!Array.isArray(result.body)) invalid('File exports require a complete row result');
      return {
        collection: association.targetCollection,
        data: result.body as Record<string, unknown>[],
        columns,
        title,
        tenantId: captured.identity.tenantId,
        assertCurrent: result.assertCurrent,
      };
    }
    const preparation = await this.prepareRelated(ctx, captured, authorize, captured.params, undefined, assertCurrent);
    preparation.assertCurrent();
    const data = await this.reader(captured, preparation.related).fromResource(
      ctx,
      captured.identity,
      captured.action,
      captured.params,
      transaction,
      captured.dateContext,
    );
    preparation.assertCurrent();
    if (!Array.isArray(data)) invalid('File exports require a complete row result');
    return {
      collection: this.db.getCollection(captured.action.resourceName),
      data: data as Record<string, unknown>[],
      columns,
      title,
      tenantId: captured.identity.tenantId,
      assertCurrent: preparation.assertCurrent,
    };
  }

  /** Stage file output and publish only while the original authorization and metadata remain valid. */
  async handleExportWithRelatedContexts(
    ctx: AccessRootReadContext & ExportXlsxRenderContext,
    authenticated: AccessIdentity,
    authorize: AccessRelatedReadAuthorizer,
    transaction?: Transaction,
    dates?: AccessReadDateContext,
  ): Promise<void> {
    const timezone = ctx.get('x-timezone');
    const input = await this.readExportWithRelatedContexts(ctx, authenticated, authorize, transaction, dates);
    const headers: Record<string, string> = {};
    // This is a file response buffer, not a cloned/prepared ACL context.
    const output: ExportXlsxRenderContext = {
      db: this.db,
      get: () => timezone,
      set: (values) => Object.assign(headers, values),
    };
    input.assertCurrent();
    await renderExportXlsxRows(output, input);
    input.assertCurrent();
    ctx.body = output.body;
    ctx.set(headers);
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
    preparation.assertCurrent();
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
    const assertRouteCurrent = () => {
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
    const paths = collectRelatedReadPaths(this.db, this.resolveIdentity, operation, params, captured.dateContext);
    const metadata = captureReadPreparationMetadata(
      this.db,
      this.prepared,
      this.resolveIdentity,
      ctx,
      this.db.getCollection(root.identity.collectionName),
      paths,
    );
    const role = captureReadPermissionMetadata(this.db, this.resolveIdentity, root.identity, captured.permission);
    if (!role) invalid('Root read is not authorized');
    const assertCurrent = () => {
      assertRouteCurrent();
      metadata();
      role();
    };
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
    const assertPreparedCurrent = () => {
      related.assertCurrent();
      assertCurrent();
    };
    assertPreparedCurrent();
    return { related, assertCurrent: assertPreparedCurrent };
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
