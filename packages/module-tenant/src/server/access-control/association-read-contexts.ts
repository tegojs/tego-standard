import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessEntryReadOperation } from './entry-reads';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter } from './read-grants';
import { collectRelatedReadPaths } from './read-paths';
import { prepareRelatedReadContexts, type AccessRelatedReadAuthorizer } from './related-read-contexts';
import { resolveResourceReadRoute } from './resource-read-routing';
import { AccessRoleFilterCompiler } from './role-filter';
import type { AccessRootReadContext, captureAssociationReadContext } from './root-read-context';
import { invalid } from './write-support';

/** Capture only this operation's relationships and rule dependencies before asynchronous authorization. */
export function captureAssociationReadPreparation(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: AccessRootReadContext,
  plan: ReturnType<typeof captureAssociationReadContext>,
  assertSourceCurrent: () => void,
) {
  const { captured, relation, targetCollection } = plan;
  const target = resolveResourceReadRoute(db, resolveIdentity, {
    resourceName: targetCollection.name,
    actionName: 'list',
  });
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
  const roots: Parameters<typeof accessMetadataGuard>[1] = [];
  const checks: Array<() => void> = [];
  const collections = new Set<Collection>();
  const captureCollection = (collection: Collection | undefined) => {
    if (!collection) invalid('Association read metadata collection is unavailable');
    if (collections.has(collection)) return;
    collections.add(collection);
    const route = resolveResourceReadRoute(db, resolveIdentity, { resourceName: collection.name, actionName: 'list' });
    const config = prepared.configuration(ctx, route.identity);
    if (!config) invalid('Association reads require prepared collection configurations');
    roots.push({ model: collection.model, config });
    checks.push(() => {
      route.assertCurrent();
      if (prepared.configuration(ctx, route.identity) !== config) invalid('Association read preparation phase changed');
    });
  };
  captureCollection(plan.sourceCollection);
  for (const path of paths) {
    let collection = plan.sourceCollection;
    for (const part of path) {
      if (part === '$through') break;
      const association = collection.model.associations[part] as (typeof collection.model.associations)[string] & {
        through?: { model?: Collection['model'] };
      };
      if (!association) invalid('Association read metadata path is unavailable');
      const through = association.through;
      const throughModel = through?.model;
      checks.push(() => {
        if (association.through !== through || through?.model !== throughModel)
          invalid('Related preparation through model changed');
      });
      if (throughModel) captureCollection(db.modelCollection.get(throughModel));
      collection = db.modelCollection.get(association.target)!;
      captureCollection(collection);
    }
  }
  const metadata = accessMetadataGuard(
    db,
    roots,
    paths.map((path) => ({
      model: plan.sourceCollection.model,
      path: path.at(-1) === '$through' ? path.slice(0, -1) : path,
    })),
  );
  const role = new AccessReadGrantAdapter(db, (collection) => {
    const identity = resolveIdentity(collection);
    return identity && accessCollectionKey(identity);
  }).capturePlan(target.identity, captured.permission, new AccessRoleFilterCompiler(db, resolveIdentity));
  if (!role) invalid('Association target read is not authorized');
  const assertCurrent = () => {
    assertSourceCurrent();
    target.assertCurrent();
    for (const check of checks) check();
    metadata();
    role.assertCurrent();
  };
  assertCurrent();
  return Object.freeze({ operation, paths: Object.freeze(paths.map((path) => Object.freeze(path))), assertCurrent });
}

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
  captured = captureAssociationReadPreparation(db, prepared, queries, resolveIdentity, ctx, plan, assertSourceCurrent),
) {
  const { relation, targetCollection } = plan;
  const { operation, paths } = captured;
  const assertCurrent = () => {
    assertSourceCurrent();
    captured.assertCurrent();
  };
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
    related.assertCurrent();
    assertCurrent();
  };
  assertPreparedCurrent();
  return { related, assertCurrent: assertPreparedCurrent };
}
