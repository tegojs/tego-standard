import { Resourcer, type Collection, type Context, type Database, type Next } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessQueryService } from './query';
import { AccessRootMutationHandler } from './root-mutation-handler';
import type { AccessRootReadContext } from './root-read-context';
import { AccessRootReadHandler } from './root-read-handler';
import { invalid } from './write-support';

interface RootRequest {
  resourceName: string;
  actionName: string;
  sourceId: unknown;
  actor: Readonly<AccessIdentity>;
  identities: readonly AccessCollectionIdentity[];
  related: AccessRootReadContext[];
  assertCurrent(): void;
}

/** Explicit root-resource composition. The tenant plugin does not install this runtime. */
export class AccessRootResourceRuntime {
  private readonly requests = new WeakMap<object, RootRequest>();
  private readonly reader: AccessRootReadHandler;
  private readonly writer: AccessRootMutationHandler;

  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
    resolveCollectionKey: (collection: Collection) => string,
    private readonly finalizeRelated: (ctx: Context, next: Next) => Promise<unknown>,
  ) {
    const queries = new AccessQueryService(db, prepared, resolveCollectionKey);
    this.reader = new AccessRootReadHandler(db, prepared, queries, resolveIdentity);
    this.writer = new AccessRootMutationHandler(db, prepared, queries, resolveIdentity);
  }

  /** Wrap the existing ACL middleware, after server authentication and tenant selection. */
  async prepare(
    ctx: Context,
    actor: AccessIdentity,
    identities: readonly AccessCollectionIdentity[],
    next: Next,
  ): Promise<void> {
    if (ctx.db !== this.db || this.requests.has(ctx)) invalid('Invalid root resource request phase');
    const { resourceName, actionName, sourceId } = ctx.action;
    const parts = resourceName?.split('.') ?? [];
    const collection = this.db.getCollection(parts[0]);
    const targetName = parts.length === 2 ? collection?.getField(parts[1])?.target : undefined;
    const target = targetName ? this.db.getCollection(targetName) : undefined;
    const selected = [collection, target]
      .filter((value): value is Collection => !!value)
      .map((value) => this.resolveIdentity(value))
      .filter((value): value is AccessCollectionIdentity => !!value)
      .map((value) => ({ ...value }));
    if (!selected.length) return void (await next());
    const capturedActor = Object.freeze({ tenantId: actor.tenantId, userId: actor.userId, roleName: actor.roleName });
    const capturedIdentities = identities.map((value) => ({ ...value }));
    await this.prepared.withPrepared(ctx, capturedIdentities, async () => {
      const configured = selected.filter((identity) => this.prepared.configuration(ctx, identity));
      if (!configured.length) return void (await next());
      if (parts.length !== 1 || sourceId !== undefined)
        invalid('Selected association resources require a dedicated runtime adapter');
      const identity = configured[0];
      const config = this.prepared.configuration(ctx, identity);
      const model = collection.model;
      const request: RootRequest = {
        resourceName,
        actionName,
        sourceId,
        actor: capturedActor,
        identities: capturedIdentities,
        related: [],
        assertCurrent: () => {
          if (
            this.requests.get(ctx) !== request ||
            ctx.db !== this.db ||
            ctx.action.resourceName !== resourceName ||
            ctx.action.actionName !== actionName ||
            ctx.action.sourceId !== sourceId ||
            this.db.getCollection(collection.name) !== collection ||
            collection.model !== model ||
            this.prepared.configuration(ctx, identity) !== config
          )
            invalid('Root resource request phase has changed');
        },
      };
      this.requests.set(ctx, request);
      try {
        await next();
        request.assertCurrent();
      } finally {
        this.requests.delete(ctx);
        for (const context of request.related) this.prepared.release(context);
      }
    });
  }

  /** Run after the existing ACL chain, before the legacy tenant guard and default action. */
  async dispatch(ctx: Context, next: Next): Promise<void> {
    const request = this.requests.get(ctx);
    if (!request) return void (await next());
    request.assertCurrent();
    const authorizeRead = async (collection: Collection): Promise<AccessRootReadContext> => {
      request.assertCurrent();
      const resourcer = new Resourcer();
      resourcer.define({ name: collection.name, actions: { list: {} } });
      const action = resourcer.getAction(collection.name, 'list').clone();
      Object.assign(action, { resourceName: collection.name, actionName: 'list' });
      action.mergeParams({ resourceName: collection.name, actionName: 'list', filterByTk: undefined });
      const decision = {
        db: this.db,
        action,
        permission: undefined as unknown,
        state: ctx.state,
        get: ctx.get.bind(ctx),
        logger: ctx.logger,
        throw: ctx.throw.bind(ctx),
      };
      request.related.push(decision);
      await this.prepared.prepare(decision, request.identities);
      await this.finalizeRelated(decision as unknown as Context, async () => {});
      request.assertCurrent();
      return decision;
    };
    const context = ctx as unknown as AccessRootReadContext;
    if (['list', 'get', 'count'].includes(request.actionName))
      await this.reader.handleResourceWithRelatedContexts(context, request.actor, authorizeRead);
    else if (request.actionName === 'export')
      await this.reader.handleExportWithRelatedContexts(
        context as AccessRootReadContext & Context,
        request.actor,
        authorizeRead,
      );
    else if (['create', 'update', 'destroy'].includes(request.actionName))
      await this.writer.handle(context, request.actor, authorizeRead);
    else invalid('Selected root action requires a dedicated runtime adapter');
    request.assertCurrent();
  }
}
