import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessFilterTreeService } from './filter-tree';
import type { AccessQueryService } from './query';
import { AccessRequestFilterParser } from './request-filter';
import { captureWorkflowReadPlan } from './workflow-read-plan';
import { invalid, validateWriteTransaction } from './write-support';

/** Internal configured-node selection, never a grant from the trigger user's role. */
export function captureWorkflowWriteSelection(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  operation: { context: object; source: Readonly<AccessCollectionIdentity>; authenticated: Readonly<AccessIdentity> },
  filter: unknown,
) {
  const plan = captureWorkflowReadPlan(
    db,
    resolveIdentity,
    { ...operation, kind: 'list' },
    { filter, limit: 1, offset: 0 },
  );
  const parsed = new AccessRequestFilterParser(db, (collection, path) => {
    plan.assertCurrent();
    const identity = resolveIdentity(collection);
    if (!identity || !plan.matches(collection, path)) invalid('Workflow selection path is unavailable');
    return {
      identity,
      fields: [
        ...Object.keys(collection.model.rawAttributes).filter(
          (name) => (collection.model.rawAttributes[name].type as { key?: string }).key !== 'VIRTUAL',
        ),
        ...Object.keys(collection.model.associations),
      ],
    };
  }).parse(operation.source, filter);
  return {
    sources: plan.sources,
    assertCurrent: plan.assertCurrent,
    async scope(transaction: Transaction | undefined) {
      plan.assertCurrent();
      await validateWriteTransaction(db, transaction, true);
      plan.assertCurrent();
      for (const source of plan.sources)
        if (!prepared.configuration(operation.context, source))
          invalid('Workflow selection requires configured related tables');
      const scoped = await new AccessFilterTreeService(db, prepared, queries).scopeRoots(
        operation.context,
        operation.source,
        operation.authenticated,
        { ...parsed, transaction },
      );
      plan.assertCurrent();
      return scoped;
    },
  };
}

export type AccessWorkflowWriteSelection = ReturnType<typeof captureWorkflowWriteSelection>;
