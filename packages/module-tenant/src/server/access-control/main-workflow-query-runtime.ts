import type { Application } from '@tego/server';

import { AccessAclScopeAdapter } from './acl-scope';
import { AccessConfigError } from './config-errors';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { AccessMainRootResourceRegistry } from './main-root-resource-registry';
import { AccessQueryService } from './query';
import type { AccessWorkflowQueryRequest } from './workflow-query-handler';
import { AccessWorkflowRootHandler, type AccessWorkflowOperationAuthority } from './workflow-root-handler';
import { invalid } from './write-support';

/** Explicit server selection only; never installed by the tenant plugin. */
export class AccessMainWorkflowQueryRuntime {
  readonly registry: AccessMainRootResourceRegistry;

  constructor(
    private readonly app: Application,
    private readonly captureAuthority: (request: unknown) => AccessWorkflowOperationAuthority,
  ) {
    this.registry = new AccessMainRootResourceRegistry(app);
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
    if (request.dataSourceName !== 'main' || !selectedRoot) return undefined;
    // Selection remains synchronous. All persistent discovery belongs to the selected executor.
    return async (incoming) => {
      if (incoming !== request) invalid('Workflow query executor request changed');
      const authority = this.captureAuthority(request);
      authority.assertCurrent();
      const discovered = await this.registry.discover(
        selections.map((identity) => identity.collectionKey),
        () => authority.assertCurrent(),
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
