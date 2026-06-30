import { Application, Context, Next, Repository } from '@tego/server';

import dayjs from 'dayjs';
import xlsx from 'node-xlsx';

import ExportPlugin from '..';
import { BULK_EXPORT_THRESHOLD, EXPORT_LENGTH_MAX } from '../constants';
import render from '../renders';
import {
  buildExportDownloadName,
  columns2Appends,
  emitSecurityViolation,
  ExportColumnsError,
  filterExportColumnsByCollection,
  getExportTenantId,
  normalizeExportColumns,
} from '../utils';

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
  let columns;
  try {
    columns = normalizeExportColumns(ctx.action.params.values?.columns ?? ctx.action.params?.columns);
  } catch (error) {
    if (error instanceof ExportColumnsError) {
      ctx.throw(400, error.message);
      return;
    }
    throw error;
  }
  const repository = ctx.db.getRepository<any>(resourceName, resourceOf) as Repository;
  const collection = repository.collection;
  columns = filterExportColumnsByCollection(columns, collection);
  const appends = columns2Appends(columns, ctx);
  const count = await repository.count({
    filter,
    context: ctx,
  });

  // Emit tenant security alert when export count reaches threshold
  if (count >= BULK_EXPORT_THRESHOLD && ctx.state.currentTenancyMode) {
    emitSecurityViolation(ctx, {
      type: 'tenant_bulk_export_alert',
      userId: ctx.state.currentUser?.id,
      actorUserId: ctx.state.actorUserId,
      tenantId: ctx.state.currentTenantId,
      collectionName: resourceName,
      action: 'export',
      details: { rowCount: count, threshold: BULK_EXPORT_THRESHOLD },
    });
  }

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
