import type { Application, Collection } from '@tego/server';

import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { assertLegacyReadBoundary } from './legacy-read-boundary';
import { invalid } from './write-support';

interface ApprovalReadTarget {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: unknown;
  readonly params: object;
  readonly context: object;
}

/** Explicit refusal-only composition; never installed by the tenant plugin. */
export class AccessMainApprovalReadBoundary {
  constructor(private readonly app: Application) {}

  assert(request: ApprovalReadTarget, selected: readonly AccessCollectionIdentity[]) {
    const selections = selected.map((identity) => ({ ...identity }));
    if (
      selections.length > 1000 ||
      selections.some((identity) => identity.dataSourceKey !== 'main') ||
      new Set(selections.map(accessCollectionKey)).size !== selections.length ||
      new Set(selections.map((identity) => identity.collectionName)).size !== selections.length
    )
      invalid('Invalid main approval read table selection');
    if (request.dataSourceName !== 'main' || !selections.length) return;
    const collection = this.app.db.getCollection(request.collectionName);
    if (!collection || collection !== request.collection || collection.db !== this.app.db)
      invalid('Approval business read target changed');
    const protectedCollection = (target: Collection) =>
      selections.some((identity) => identity.collectionName === target.name);
    assertLegacyReadBoundary(this.app.db, collection, request.params, protectedCollection, request.context);
  }
}
