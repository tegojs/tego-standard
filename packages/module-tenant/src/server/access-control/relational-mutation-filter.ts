import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessEntryReadService } from './entry-reads';
import type { AccessQueryService } from './query';
import { collectRelatedReadPaths } from './read-paths';
import { captureReadPermissionMetadata, captureReadPreparationMetadata } from './read-preparation-metadata';
import { prepareRelatedReadContexts } from './related-read-contexts';
import { captureRelatedReadPermission, type AccessRootReadContext } from './root-read-context';
import { invalid, validateWriteTransaction } from './write-support';

/** HTTP conditions use finalized human read decisions, never configured-workflow authority. */
export function prepareRelationalMutationFilter(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  ctx: object,
  collection: Collection,
  source: AccessCollectionIdentity,
  authenticated: AccessIdentity,
  request: unknown,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
) {
  const operation = { kind: 'list' as const, context: ctx, source, authenticated };
  const paths = collectRelatedReadPaths(db, resolveIdentity, operation, { filter: request });
  if (!paths.length) return;
  const metadata = captureReadPreparationMetadata(db, prepared, resolveIdentity, ctx, collection, paths);
  const checks: Array<() => void> = [metadata];
  const assertCurrent = () => {
    for (const check of checks) check();
  };
  return {
    assertCurrent,
    async resolve(
      authorize: ((collection: Collection) => Promise<AccessRootReadContext | null>) | undefined,
      assertEntryCurrent: () => void,
    ) {
      if (!authorize || typeof authenticated.roleName !== 'string')
        invalid('Filtered mutations require independent read decisions');
      const current = () => {
        assertEntryCurrent();
        assertCurrent();
      };
      current();
      const root = await authorize(collection);
      current();
      if (!root) invalid('Mutation filter read is not authorized');
      const decision = captureRelatedReadPermission(db, collection, authenticated.roleName, root);
      const permission = captureReadPermissionMetadata(db, resolveIdentity, source, decision);
      if (!permission) invalid('Mutation filter read is not authorized');
      checks.push(permission);
      const related = await prepareRelatedReadContexts(db, resolveIdentity, operation, paths, async (target) => {
        current();
        const result = await authorize(target);
        current();
        return result;
      });
      checks.push(related.assertCurrent);
      current();
      const filter = new AccessEntryReadService(db, prepared, queries, resolveIdentity, (target, path, read) => {
        current();
        if (!path.length) return decision;
        const context = related(target, path, read);
        return context && captureRelatedReadPermission(db, target, authenticated.roleName!, context);
      }).captureFilter(ctx, source, authenticated, request);
      checks.push(filter.assertCurrent);
      current();
      return async (transaction: Transaction) => {
        current();
        await validateWriteTransaction(db, transaction, true);
        current();
        const scoped = await filter.scope(transaction);
        current();
        return { where: scoped.where!, bind: scoped.bind };
      };
    },
  };
}
