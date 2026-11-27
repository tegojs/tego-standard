import type { Context, Next } from '@tego/server';

import { importXlsx } from './importXlsx';

export type ImportXlsxExecutor = (ctx: Context) => Promise<void>;
/** Server-only synchronous selection. The executor owns authorization, parsing, writes and the response. */
export type ImportXlsxResolver = (ctx: Context) => ImportXlsxExecutor | undefined;

/** Only explicit non-selection preserves the existing spreadsheet parser and import transaction. */
export function createImportXlsx(resolve: ImportXlsxResolver) {
  if (typeof resolve !== 'function') throw new TypeError('Import resolver must be a server function');
  return async (ctx: Context, next: Next): Promise<void> => {
    const execute = resolve(ctx);
    if (execute === undefined) {
      await importXlsx(ctx, next);
      return;
    }
    if (typeof execute !== 'function') {
      // Consume rejected asynchronous selections, but never accept their result.
      await execute;
      throw new TypeError('Import resolver must select an executor or undefined');
    }
    await execute(ctx);
  };
}
