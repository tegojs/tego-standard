import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter, type AccessEntryReadPermission } from './read-grants';
import {
  AccessReadService,
  type AccessGetRequest,
  type AccessListRequest,
  type AccessReadRequest,
  type AccessSumRequest,
} from './reads';
import { AccessRoleFilterCompiler } from './role-filter';
import { invalid } from './write-support';

export interface AccessEntryReadOperation {
  readonly kind: 'list' | 'get' | 'count' | 'sum';
  readonly context: object;
  readonly source: Readonly<AccessCollectionIdentity>;
  readonly authenticated: Readonly<AccessIdentity>;
}

/** Internal entry bridge: permissions must already include operation decisions and resolved ACL variables. */
export class AccessEntryReadService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
    private readonly resolvePermission: (
      collection: Collection,
      path: readonly string[],
      operation: AccessEntryReadOperation,
    ) => AccessEntryReadPermission | null,
  ) {}

  private operation(
    kind: AccessEntryReadOperation['kind'],
    context: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
  ) {
    const operation: AccessEntryReadOperation = Object.freeze({
      kind,
      context,
      source: Object.freeze({ ...source }),
      authenticated: Object.freeze({ ...authenticated }),
    });
    // A fresh checker set per operation prevents concurrent requests from sharing authorization state.
    const checks: Array<() => void> = [];
    const roles = new AccessRoleFilterCompiler(this.db, this.resolveIdentity);
    const adapter = new AccessReadGrantAdapter(this.db, (collection) => {
      const identity = this.resolveIdentity(collection);
      return identity && accessCollectionKey(identity);
    });
    return new AccessReadService(
      this.db,
      this.prepared,
      this.queries,
      (collection, path) => {
        const identity = this.resolveIdentity(collection);
        if (!identity) invalid('Entry read collection identity is unavailable');
        const permission = this.resolvePermission(collection, path, operation);
        if (!permission) return null;
        // Validate the original descriptors before copying anything: fields/own may be non-enumerable.
        const plan = adapter.capturePlan(identity, permission, roles);
        if (!plan) return null;
        checks.push(plan.assertCurrent);
        // Keep lifecycle functions outside grants: downstream parsers and sorting clone grants as data.
        return plan.grant;
      },
      () => {
        for (const check of checks) check();
      },
    );
  }

  list(ctx: object, source: AccessCollectionIdentity, authenticated: AccessIdentity, request: AccessListRequest) {
    return this.operation('list', ctx, source, authenticated).list(ctx, source, authenticated, request);
  }

  get(ctx: object, source: AccessCollectionIdentity, authenticated: AccessIdentity, request: AccessGetRequest) {
    return this.operation('get', ctx, source, authenticated).get(ctx, source, authenticated, request);
  }

  count(ctx: object, source: AccessCollectionIdentity, authenticated: AccessIdentity, request: AccessReadRequest = {}) {
    return this.operation('count', ctx, source, authenticated).count(ctx, source, authenticated, request);
  }

  sum(ctx: object, source: AccessCollectionIdentity, authenticated: AccessIdentity, request: AccessSumRequest) {
    return this.operation('sum', ctx, source, authenticated).sum(ctx, source, authenticated, request);
  }
}
