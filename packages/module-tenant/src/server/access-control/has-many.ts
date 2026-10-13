import type { Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessMutationService } from './mutation';
import type { AccessQueryService } from './query';
import type { AccessReferenceService } from './references';
import { AccessTargetForeignKeyService, type TargetForeignKeyWriteRequest } from './target-foreign-key';

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
  ) {
    return this.writeChildren(ctx, source, target, authenticated, request);
  }
}
