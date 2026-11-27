import { isDeepStrictEqual } from 'node:util';
import type { Application } from '@tego/server';

import { AccessAclScopeAdapter } from './acl-scope';
import { AccessConfigError } from './config-errors';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { assertLegacyReadBoundary } from './legacy-read-boundary';
import { AccessMainRootResourceRegistry } from './main-root-resource-registry';
import { AccessQueryService } from './query';
import type { AccessWorkflowQueryRequest } from './workflow-query-handler';
import { AccessWorkflowRootHandler, type AccessWorkflowOperationAuthority } from './workflow-root-handler';
import { cloneDeep, invalid } from './write-support';

interface WorkflowAggregateReadTarget {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: unknown;
  readonly params: object;
  readonly context: object;
  readonly association?: {
    readonly collectionName: string;
    readonly collection: unknown;
    readonly name: string;
  };
}

/** Explicit server selection only; never installed by the tenant plugin. */
export class AccessMainWorkflowQueryRuntime {
  readonly registry: AccessMainRootResourceRegistry;

  constructor(
    private readonly app: Application,
    private readonly captureAuthority: (request: unknown) => AccessWorkflowOperationAuthority,
  ) {
    this.registry = new AccessMainRootResourceRegistry(app);
  }

  /** Refusal-only boundary; a query/list executor does not authorize aggregate SQL. */
  assertAggregateBoundary(request: WorkflowAggregateReadTarget, selected: readonly AccessCollectionIdentity[]) {
    const selections = selected.map((identity) => ({ ...identity }));
    if (
      selections.length > 1000 ||
      selections.some((identity) => identity.dataSourceKey !== 'main') ||
      new Set(selections.map(accessCollectionKey)).size !== selections.length ||
      new Set(selections.map((identity) => identity.collectionName)).size !== selections.length
    )
      invalid('Invalid main workflow aggregate table selection');
    if (request.dataSourceName !== 'main' || !selections.length) return;
    const collection = this.app.db.getCollection(request.collectionName);
    if (!collection || collection !== request.collection) invalid('Workflow aggregate target changed');
    const protectedCollection = (target: typeof collection) =>
      selections.some((identity) => identity.collectionName === target.name);
    if (protectedCollection(collection)) invalid('Selected workflow aggregate reads require a dedicated adapter');
    if (request.association) {
      const source = this.app.db.getCollection(request.association.collectionName);
      if (!source || source !== request.association.collection)
        invalid('Workflow aggregate association source changed');
      assertLegacyReadBoundary(
        this.app.db,
        source,
        { appends: [request.association.name] },
        protectedCollection,
        request.context,
      );
    }
    assertLegacyReadBoundary(this.app.db, collection, request.params, protectedCollection, request.context);
  }

  resolve(
    request: AccessWorkflowQueryRequest,
    selected: readonly AccessCollectionIdentity[],
  ):
    | ((request: AccessWorkflowQueryRequest) => Promise<Record<string, unknown>[] | Record<string, unknown> | null>)
    | undefined {
    const selections = selected.map((identity) => ({ ...identity }));
    if (
      selections.length > 1000 ||
      selections.some((identity) => identity.dataSourceKey !== 'main') ||
      new Set(selections.map(accessCollectionKey)).size !== selections.length ||
      new Set(selections.map((identity) => identity.collectionName)).size !== selections.length
    )
      invalid('Invalid main workflow table selection');
    const selectedRoot = selections.find((identity) => identity.collectionName === request.collectionName);
    if (request.dataSourceName !== 'main') return undefined;
    if (!selectedRoot) {
      if (selections.length) {
        const collection = this.app.db.getCollection(request.collectionName);
        if (!collection || collection !== request.collection) invalid('Legacy workflow query target changed');
        assertLegacyReadBoundary(
          this.app.db,
          collection,
          request.query as object,
          (target) => selections.some((identity) => identity.collectionName === target.name),
          request.context,
        );
      }
      return undefined;
    }
    const query = request.query;
    const captured = cloneDeep(query);
    // Selection remains synchronous. All persistent discovery belongs to the selected executor.
    return async (incoming) => {
      if (incoming !== request) invalid('Workflow query executor request changed');
      const authority = this.captureAuthority(request);
      authority.assertCurrent();
      const assertCurrent = () => {
        authority.assertCurrent();
        if (request.query !== query || !isDeepStrictEqual(cloneDeep(query), captured))
          invalid('Workflow query parameters changed during discovery');
      };
      const discovered = await this.registry.discover(
        selections.map((identity) => identity.collectionKey),
        assertCurrent,
      );
      for (const selection of selections) {
        const actual = discovered.identities.find((identity) => identity.collectionName === selection.collectionName);
        if (!actual || accessCollectionKey(actual) !== accessCollectionKey(selection))
          throw new AccessConfigError('ACCESS_CONFIG_CONFLICT', 'Access configuration metadata changed', 409);
      }
      const prepared = new AccessAclScopeAdapter(this.app.acl, 'main', this.registry.store, this.app.db);
      const queries = new AccessQueryService(this.app.db, prepared, discovered.resolveCollectionKey);
      const handler = new AccessWorkflowRootHandler(
        this.app.db,
        prepared,
        queries,
        discovered.resolveIdentity,
        this.captureAuthority,
      );
      const result = await handler.query(request);
      discovered.assertCurrent();
      return result;
    };
  }
}
