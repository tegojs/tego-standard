import type { Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessMutationService } from './mutation';
import type { AccessQueryService } from './query';
import type { AccessReferenceService } from './references';
import { AccessTargetForeignKeyService, type TargetForeignKeyWriteRequest } from './target-foreign-key';
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
    return this.writeChildren(ctx, source, target, authenticated, {
      ...selection,
      operation: 'set',
      targetKeys: targetKey === null ? [] : [targetKey],
    });
  }
}
