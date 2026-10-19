import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessEntryReadOperation } from './entry-reads';
import type { AccessQueryService } from './query';
import { collectRelatedReadPaths } from './read-paths';
import { prepareRelatedReadContexts, type AccessRelatedReadAuthorizer } from './related-read-contexts';
import { resolveResourceReadRoute } from './resource-read-routing';
import type { AccessRootReadContext, captureAssociationReadContext } from './root-read-context';
import { invalid } from './write-support';

/** Plan relative to the target; authorize deeper paths relative to the original concrete source. */
export async function prepareAssociationReadContexts(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: AccessRootReadContext,
  plan: ReturnType<typeof captureAssociationReadContext>,
  authorize: AccessRelatedReadAuthorizer,
  assertSourceCurrent: () => void,
) {
  const { captured, relation, targetCollection } = plan;
  const target = resolveResourceReadRoute(db, resolveIdentity, {
    resourceName: targetCollection.name,
    actionName: 'list',
  });
  const assertCurrent = () => {
    assertSourceCurrent();
    target.assertCurrent();
  };
  const operation: AccessEntryReadOperation = Object.freeze({
    kind: captured.action.actionName,
    context: ctx,
    source: plan.identity,
    authenticated: captured.identity,
  });
  // Detail keys were validated when captured. Metadata planning only needs selection/filter, not a key.
  const detail = operation.kind === 'get';
  const params = detail
    ? Object.fromEntries(Object.entries(captured.params).filter(([key]) => key !== 'filterByTk'))
    : captured.params;
  const nested = collectRelatedReadPaths(
    db,
    prepared,
    queries,
    resolveIdentity,
    { ...operation, kind: detail ? 'list' : operation.kind, source: target.identity },
    params,
    captured.dateContext,
  );
  const paths = [[relation], ...nested.map((path) => [relation, ...path])];
  if (plan.sourceCollection.model.associations[relation].associationType === 'BelongsToMany')
    paths.push([relation, '$through']);
  assertCurrent();
  const related = await prepareRelatedReadContexts(
    db,
    resolveIdentity,
    operation,
    paths,
    async (collection, path, op) => {
      assertCurrent();
      // This node already has its final get/list/count decision; execution never uses a substitute list grant.
      if (path.length === 1) {
        if (path[0] !== relation || collection !== targetCollection) invalid('Association permission target changed');
        return null;
      }
      const context = await authorize(collection, path, op);
      assertCurrent();
      return context;
    },
  );
  const assertPreparedCurrent = () => {
    assertCurrent();
    related.assertCurrent();
  };
  assertPreparedCurrent();
  return { related, assertCurrent: assertPreparedCurrent };
}
