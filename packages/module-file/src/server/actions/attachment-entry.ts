import type { Collection, Context, Next } from '@tego/server';

export type AttachmentActionExecutor = (ctx: Context) => Promise<void>;
/** Server-only route selection may precede authentication; execution waits for the existing ACL pipeline. */
export type AttachmentActionResolver = (ctx: Context) => AttachmentActionExecutor | undefined;
type Middleware = (ctx: Context, next: Next) => Promise<void>;

/** Optional storage boundary only. Selected executors own authorization, storage, transactions and response. */
export function createAttachmentActionEntry(resolve: AttachmentActionResolver) {
  if (typeof resolve !== 'function') throw new TypeError('Attachment resolver must be a server function');
  const pending = new WeakMap<
    Context,
    {
      execute: AttachmentActionExecutor;
      collection: Collection;
      db: Context['db'];
      model: Collection['model'];
      action: Context['action'];
      resourceName: string;
      actionName: string;
      executed: boolean;
    }
  >();
  return {
    select: async (ctx: Context, next: Next): Promise<void> => {
      const { resourceName, actionName } = ctx.action;
      const collection = ctx.db.getCollection(resourceName);
      if (collection?.options.template !== 'file' || !['create', 'upload', 'destroy'].includes(actionName)) {
        await next();
        return;
      }
      if (pending.has(ctx)) throw new TypeError('Attachment selection is already active for this request');
      const db = ctx.db;
      const action = ctx.action;
      const model = collection.model;
      const execute = resolve(ctx);
      if (execute === undefined) {
        await next();
        return;
      }
      if (typeof execute !== 'function') {
        // Observe rejected asynchronous selectors, but never accept asynchronous non-selection.
        await execute;
        throw new TypeError('Attachment resolver must select an executor or undefined');
      }
      const selection = {
        execute,
        collection,
        db,
        model,
        action,
        resourceName,
        actionName,
        executed: false,
      };
      pending.set(ctx, selection);
      try {
        await next();
      } finally {
        if (pending.get(ctx) === selection) pending.delete(ctx);
      }
    },
    storage:
      (legacy: Middleware): Middleware =>
      async (ctx, next) => {
        if (pending.has(ctx)) await next();
        else await legacy(ctx, next);
      },
    execute: async (ctx: Context, next: Next): Promise<void> => {
      const selection = pending.get(ctx);
      if (!selection) {
        await next();
        return;
      }
      if (
        selection.executed ||
        ctx.db !== selection.db ||
        ctx.action !== selection.action ||
        ctx.action.resourceName !== selection.resourceName ||
        ctx.action.actionName !== selection.actionName ||
        ctx.db.getCollection(selection.resourceName) !== selection.collection ||
        selection.collection.model !== selection.model ||
        selection.collection.options.template !== 'file'
      )
        throw new TypeError('Selected attachment action identity changed');
      selection.executed = true;
      // No next(): the selected executor replaces both storage middleware and the original final action.
      await selection.execute(ctx);
    },
  };
}
