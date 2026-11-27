import type { Context, Next } from '@tego/server';

import { query } from './query';

export type ChartQueryExecutor = (ctx: Context) => Promise<void>;
/** A server-only, synchronous decision; undefined explicitly preserves the existing chart pipeline. */
export type ChartQueryResolver = (ctx: Context) => ChartQueryExecutor | undefined;

/** Optional entry bridge. Selected executors own authorization and never enter the legacy result cache. */
export function createChartQuery(resolve: ChartQueryResolver) {
  return async (ctx: Context, next: Next): Promise<void> => {
    const execute = resolve(ctx);
    if (execute === undefined) {
      await query(ctx, next);
      return;
    }
    // Invalid or asynchronous selection must not fall through to a less restrictive query.
    if (typeof execute !== 'function') {
      // Consume rejected asynchronous selections without accepting their result.
      await execute;
      throw new TypeError('Chart query resolver must select an executor or undefined');
    }
    await execute(ctx);
  };
}
