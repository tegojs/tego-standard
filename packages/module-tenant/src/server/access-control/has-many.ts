import { Transaction, type Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessMutationService } from './mutation';
import type { AccessQueryService } from './query';
import type { AccessReferenceService } from './references';
import {
  AccessTargetForeignKeyService,
  type TargetForeignKeyMutationEntry,
  type TargetForeignKeyWriteRequest,
} from './target-foreign-key';
import { invalid } from './write-support';

export type HasManyWriteRequest = TargetForeignKeyWriteRequest;

export class AccessHasManyService extends AccessTargetForeignKeyService {
  constructor(
    db: Database,
    prepared: AccessAclScopeAdapter,
    queries: AccessQueryService,
    mutations: AccessMutationService,
    references: AccessReferenceService,
  ) {
    super(db, prepared, queries, mutations, references, 'HasMany');
  }

  withChildren(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: HasManyWriteRequest,
    entry?: TargetForeignKeyMutationEntry,
  ) {
    return this.writeChildren(ctx, source, target, authenticated, request, entry);
  }

  /** The caller owns commit/rollback and must roll back the whole transaction on any error. */
  async withChildrenInTransaction(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: HasManyWriteRequest,
    transaction: Transaction,
    entry?: TargetForeignKeyMutationEntry,
  ) {
    if (!(transaction instanceof Transaction)) invalid('An active root write transaction is required');
    return this.writeChildren(ctx, source, target, authenticated, request, entry, transaction);
  }
}
