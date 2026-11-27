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
import { cloneDeep, invalid, plain } from './write-support';

export interface HasOneWriteRequest extends Omit<TargetForeignKeyWriteRequest, 'operation' | 'targetKeys'> {
  targetKey: string | number | null;
}

export class AccessHasOneService extends AccessTargetForeignKeyService {
  constructor(
    db: Database,
    prepared: AccessAclScopeAdapter,
    queries: AccessQueryService,
    mutations: AccessMutationService,
    references: AccessReferenceService,
  ) {
    super(db, prepared, queries, mutations, references, 'HasOne');
  }

  async withTarget(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: HasOneWriteRequest,
    entry?: TargetForeignKeyMutationEntry,
  ) {
    return this.writeTarget(ctx, source, target, authenticated, request, entry);
  }

  /** The caller owns commit/rollback and must roll back the whole transaction on any error. */
  async withTargetInTransaction(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: HasOneWriteRequest,
    transaction: Transaction,
    entry?: TargetForeignKeyMutationEntry,
  ) {
    if (!(transaction instanceof Transaction)) invalid('An active root write transaction is required');
    return this.writeTarget(ctx, source, target, authenticated, request, entry, transaction);
  }

  private async writeTarget(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: HasOneWriteRequest,
    entry?: TargetForeignKeyMutationEntry,
    transaction?: Transaction,
  ) {
    request = cloneDeep(request);
    if (
      !plain(request) ||
      !Object.hasOwn(request, 'targetKey') ||
      Object.hasOwn(request, 'targetKeys') ||
      Object.hasOwn(request, 'operation')
    )
      invalid('A HasOne mutation requires one explicit target or null');
    const { targetKey, ...selection } = request;
    return this.writeChildren(
      ctx,
      source,
      target,
      authenticated,
      {
        ...selection,
        operation: 'set',
        targetKeys: targetKey === null ? [] : [targetKey],
      },
      entry,
      transaction,
    );
  }

  async removeTarget(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: Omit<HasOneWriteRequest, 'targetKey'>,
    entry?: TargetForeignKeyMutationEntry,
  ) {
    return this.writeRemoval(ctx, source, target, authenticated, request, entry);
  }

  /** The caller owns commit/rollback and must roll back the whole transaction on any error. */
  async removeTargetInTransaction(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: Omit<HasOneWriteRequest, 'targetKey'>,
    transaction: Transaction,
    entry?: TargetForeignKeyMutationEntry,
  ) {
    if (!(transaction instanceof Transaction)) invalid('An active root write transaction is required');
    return this.writeRemoval(ctx, source, target, authenticated, request, entry, transaction);
  }

  private async writeRemoval(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: Omit<HasOneWriteRequest, 'targetKey'>,
    entry?: TargetForeignKeyMutationEntry,
    transaction?: Transaction,
  ) {
    request = cloneDeep(request);
    if (
      !plain(request) ||
      Object.hasOwn(request, 'targetKey') ||
      Object.hasOwn(request, 'targetKeys') ||
      Object.hasOwn(request, 'operation')
    )
      invalid('A HasOne remove uses the current target without an explicit selector');
    return this.writeChildren(
      ctx,
      source,
      target,
      authenticated,
      { ...request, operation: 'remove', targetKeys: [] },
      entry,
      transaction,
    );
  }
}
