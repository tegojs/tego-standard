import type { Context, Next } from '@tego/server';

import { exportXlsx } from './export-xlsx';

export type ExportXlsxExecutor = (ctx: Context) => Promise<void>;
/** Server-only synchronous selection. The executor owns authorization, data and the response. */
export type ExportXlsxResolver = (ctx: Context) => ExportXlsxExecutor | undefined;

/** Only explicit non-selection preserves the existing query and worker export pipeline. */
export function createExportXlsx(resolve: ExportXlsxResolver) {
  return async (ctx: Context, next: Next): Promise<void> => {
    const execute = resolve(ctx);
    if (execute === undefined) {
      await exportXlsx(ctx, next);
      return;
    }
    if (typeof execute !== 'function') {
      // Consume rejected asynchronous selections, but never accept their result.
      await execute;
      throw new TypeError('Export resolver must select an executor or undefined');
    }
    await execute(ctx);
  };
}
