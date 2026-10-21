import type { Collection, Context, Model } from '@tego/server';

import dayjs from 'dayjs';
import xlsx from 'node-xlsx';

import render from '../renders';
import { buildExportDownloadName, normalizeExportColumns } from '../utils';

export interface ExportXlsxRenderInput {
  collection: Collection;
  columns: ReturnType<typeof normalizeExportColumns>;
  /** Already authorized rows; this method never queries the business repository. */
  data: readonly Model[];
  title?: string;
  tenantId?: string | number | null;
}

export interface ExportXlsxRowsInput extends Omit<ExportXlsxRenderInput, 'data'> {
  /** Authorized projections only; this renderer does not grant access or reload omitted values. */
  data: readonly Record<string, unknown>[];
}

interface ExportInclude {
  association: Collection['model']['associations'][string];
  include: ExportInclude[];
}

function exportIncludes(collection: Collection, paths: readonly string[][]): ExportInclude[] {
  const relations = new Map<string, string[][]>();
  for (const [name, ...rest] of paths) {
    if (!Object.hasOwn(collection.model.associations, name)) continue;
    const nested = relations.get(name) ?? [];
    if (rest.length) nested.push(rest);
    relations.set(name, nested);
  }
  return Array.from(relations, ([name, nested]) => ({
    association: collection.model.associations[name],
    include: exportIncludes(collection.db.getCollection(collection.getField(name).target), nested),
  }));
}

/** Adapt already authorized rows to existing cell formatters without issuing business queries. */
export async function renderExportXlsxRows(ctx: Context, input: ExportXlsxRowsInput): Promise<void> {
  const include = exportIncludes(
    input.collection,
    input.columns.map((column) => column.dataIndex),
  );
  const data = input.collection.model.bulkBuild([...input.data], { raw: true, isNewRecord: false, include });
  await renderExportXlsx(ctx, { ...input, data });
}

/** Reuse existing cell formatting without reloading or expanding the supplied records. */
export async function renderExportXlsx(ctx: Context, input: ExportXlsxRenderInput): Promise<void> {
  const { collection, columns, data, title, tenantId } = input;
  const collectionFields = columns.map((col) => collection.fields.get(col.dataIndex[0]));
  const { rows, ranges } = await render(
    { columns, fields: collectionFields, data, utcOffset: ctx.get('X-Timezone') },
    ctx.db,
  );
  const timezone = ctx.get('x-timezone');
  if (timezone) {
    for (const data of rows) {
      for (const key in data) {
        if (data[key] instanceof Date) {
          data[key] = dayjs(data[key]).utcOffset(timezone).format('YYYY-MM-DD HH:mm:ss');
        }
      }
    }
  }
  const body = xlsx.build([{ name: 'Sheet 1', data: rows, options: { '!merges': ranges } }]);
  ctx.body = body;
  ctx.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename=${encodeURI(buildExportDownloadName(title, tenantId))}.xlsx`,
  });
}
