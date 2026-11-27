import type { Database, Transaction, WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessFilterTreeService, type AccessFilterNode } from './filter-tree';
import type { AccessQueryService, ScopedAccessQuery } from './query';
import { cloneDeep, invalid, plain } from './write-support';

export interface AssociationFilterRequest {
  association: string;
  exists: boolean;
  through?: AccessCollectionIdentity;
  /** Trusted server-parsed predicates; entry adapters must authorize actions and filter fields. */
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  throughWhere?: WhereOptions;
  throughBind?: Record<string, unknown>;
  transaction?: Transaction;
}

export interface AssociationFilterPlan extends ScopedAccessQuery {
  /** Call before execution and after each database await, before exposing any result. */
  assertCurrent(): void;
}

/** Single-hop existence plans only; no global ORM/ACL interception or business activation. */
export class AccessAssociationFilterService {
  private readonly trees: AccessFilterTreeService;

  constructor(db: Database, prepared: AccessAclScopeAdapter, queries: AccessQueryService) {
    this.trees = new AccessFilterTreeService(db, prepared, queries);
  }

  async scopeRoots(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AssociationFilterRequest,
  ): Promise<AssociationFilterPlan> {
    source = { ...source };
    target = { ...target };
    authenticated = { ...authenticated };
    const allowed = [
      'association',
      'exists',
      'through',
      'sourceWhere',
      'sourceBind',
      'targetWhere',
      'targetBind',
      'throughWhere',
      'throughBind',
      'transaction',
    ];
    if (
      !plain(request) ||
      Reflect.ownKeys(request).some(
        (key) =>
          typeof key !== 'string' ||
          !allowed.includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(request, key)!, 'value'),
      )
    )
      invalid('Unsupported association filter input');
    const { transaction, ...input } = request;
    request = { ...cloneDeep(input), transaction };
    const filter: AccessFilterNode = {
      type: 'association',
      association: request.association,
      exists: request.exists,
      target,
      targetWhere: request.targetWhere,
      targetBind: request.targetBind,
      ...Object.fromEntries(
        (['through', 'throughWhere', 'throughBind'] as const)
          .filter((key) => Object.hasOwn(request, key))
          .map((key) => [key, request[key]]),
      ),
    };
    return this.trees.scopeRoots(ctx, source, authenticated, {
      filter,
      sourceWhere: request.sourceWhere,
      sourceBind: request.sourceBind,
      transaction,
    });
  }
}
