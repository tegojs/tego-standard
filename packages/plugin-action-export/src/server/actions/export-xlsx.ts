import { Application, Context, Next, Repository } from '@tego/server';

import dayjs from 'dayjs';
import xlsx from 'node-xlsx';

import ExportPlugin from '..';
import { EXPORT_LENGTH_MAX } from '../constants';
import render from '../renders';
import { buildExportDownloadName, columns2Appends, getExportTenantId } from '../utils';

function uniqueTenantIds(ids?: Array<string | number>) {
  return Array.from(new Set(ids || []));
}

function getExportTenantContext(ctx: Context) {
  const currentTenantId = getExportTenantId(ctx);

  if (!currentTenantId) {
    return;
  }

  return {
    currentTenant: ctx.state.currentTenant || { id: currentTenantId },
    currentTenantId,
    currentTenantDescendantIds: uniqueTenantIds(ctx.state.currentTenantDescendantIds),
    currentTenancyMode: ctx.state.currentTenancyMode,
    currentLegacyDataTenantIds: uniqueTenantIds(ctx.state.currentLegacyDataTenantIds),
  };
}

export async function exportXlsx(ctx: Context, next: Next) {
  const { filter, sort, fields, except } = ctx.action.params;
  const title = ctx.action.params.title ?? ctx.action.params.values?.title;
  const { resourceName, resourceOf } = ctx.action;
  const currentTenantId = getExportTenantId(ctx);
  const tenantContext = getExportTenantContext(ctx);
  let columns = ctx.action.params.values?.columns || ctx.action.params?.columns;
  if (typeof columns === 'string') {
    columns = JSON.parse(columns);
  }
  const repository = ctx.db.getRepository<any>(resourceName, resourceOf) as Repository;
  const collection = repository.collection;
  columns = columns?.filter((col) => collection.hasField(col.dataIndex[0]) && col?.dataIndex?.length > 0);
  const appends = columns2Appends(columns, ctx);
  const count = await repository.count({
    filter,
    context: ctx,
  });
  if (count > EXPORT_LENGTH_MAX) {
    // ctx.throw(400, `Too many records to export: ${count}`);
    const app = ctx.tego as Application;
    if (!app.worker?.available) {
      ctx.throw(400, `Too many records to export: ${count} > ${EXPORT_LENGTH_MAX}`);
    }
    let fileWithPath;
    try {
      // 调用工作线程返回文件路径
      fileWithPath = await app.worker.callPluginMethod({
        plugin: ExportPlugin,
        method: 'workerExportXlsx', // TODO: 这样不够优雅
        concurrency: 1,
        globalConcurrency: 1,
        params: {
          title,
          filter,
          sort,
          fields,
          except,
          columns,
          resourceName,
          resourceOf,
          appends,
          currentTenantId,
          tenantContext,
          timezone: ctx.get('X-Timezone'),
        },
      });
    } catch (error) {
      ctx.throw(500, ctx.t(error.message, { ns: 'worker-thread' }));
    }
    if (!fileWithPath) {
      ctx.throw(500, 'Export failed');
    }
    ctx.body = {
      filename: `/${fileWithPath}`,
    };
    return next();
  }
  const data = await repository.find({
    filter,
    fields,
    appends,
    except,
    sort,
    context: ctx,
  });
  const collectionFields = columns.map((col) => collection.fields.get(col.dataIndex[0]));
  const { rows, ranges } = await render(
    { columns, fields: collectionFields, data, utcOffset: ctx.get('X-Timezone') },
    ctx.db,
  );
  const timezone = ctx.get('x-timezone');
  // TODO: 合并到render中处理
  if (timezone) {
    for (const data of rows) {
      for (const key in data) {
        if (data[key] instanceof Date) {
          data[key] = dayjs(data[key]).utcOffset(timezone).format('YYYY-MM-DD HH:mm:ss');
        }
      }
    }
  }
  ctx.body = xlsx.build([
    {
      name: 'Sheet 1',
      data: rows,
      options: {
        '!merges': ranges,
      },
    },
  ]);

  ctx.set({
    'Content-Type': 'application/octet-stream',
    // to avoid "invalid character" error in header (RFC)
    'Content-Disposition': `attachment; filename=${encodeURI(buildExportDownloadName(title, currentTenantId))}.xlsx`,
  });

  await next();
}
