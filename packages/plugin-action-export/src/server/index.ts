import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { InstallOptions, Plugin, Repository } from '@tego/server';

import dayjs from 'dayjs';
import xlsx from 'node-xlsx';

import { exportXlsx } from './actions';
import { EXPORT_WORKER_PAGESIZE } from './constants';
import render from './renders';
import {
  buildWorkerExportFileName,
  buildWorkerExportRelativePath,
  buildWorkerExportSavePath,
  getExportTenantId,
} from './utils';

type ExportTenantContext = {
  currentTenant?: any;
  currentTenantId?: string | number;
  currentTenantDescendantIds?: Array<string | number>;
  currentTenancyMode?: string;
  currentLegacyDataTenantIds?: Array<string | number>;
};

function stripTenantFilter(filter: any): any {
  if (!filter || typeof filter !== 'object') {
    return filter;
  }

  if (Array.isArray(filter)) {
    return filter
      .map(stripTenantFilter)
      .filter((item) => item && (typeof item !== 'object' || Object.keys(item).length > 0));
  }

  const next = Object.fromEntries(
    Object.entries(filter)
      .filter(([key]) => key !== 'tenantId' && !key.startsWith('tenantId.'))
      .map(([key, value]) => [key, stripTenantFilter(value)]),
  );

  for (const key of ['$and', '$or']) {
    if (Array.isArray(next[key])) {
      next[key] = next[key].filter((item: any) => item && (typeof item !== 'object' || Object.keys(item).length > 0));
      if (next[key].length === 0) {
        delete next[key];
      }
    }
  }

  return next;
}

function canReadLegacyData(tenantId: string | number, legacyDataTenantIds?: Array<string | number>) {
  return (legacyDataTenantIds || []).some((item) => `${item}` === `${tenantId}`);
}

function getLegacyDataTenantIds(tenantContext: ExportTenantContext, collection: any) {
  if (Array.isArray(tenantContext.currentLegacyDataTenantIds)) {
    return Array.from(new Set(tenantContext.currentLegacyDataTenantIds));
  }

  return collection?.options?.legacyDataTenantIds || [];
}

function appendTenantFilter(original: any, tenantFilter: any) {
  const sanitizedOriginal = stripTenantFilter(original);

  if (!sanitizedOriginal || Object.keys(sanitizedOriginal).length === 0) {
    return tenantFilter;
  }

  return {
    $and: [sanitizedOriginal, tenantFilter],
  };
}

function buildTenantFilter(tenantId: string | number, includeLegacyData = false) {
  if (!includeLegacyData) {
    return { tenantId };
  }

  return {
    $or: [{ tenantId }, { tenantId: null }],
  };
}

function buildInheritedTenantFilter(tenantIds: Array<string | number>, includeLegacyData = false) {
  const tenantFilter = { tenantId: { $in: tenantIds } };

  if (!includeLegacyData) {
    return tenantFilter;
  }

  return {
    $or: [tenantFilter, { tenantId: null }],
  };
}

function buildWorkerTenantState(currentTenantId?: string | number, tenantContext?: ExportTenantContext) {
  const tenantId = getExportTenantId({
    state: tenantContext,
    currentTenantId,
  });

  if (!tenantId) {
    return;
  }

  return {
    ...tenantContext,
    currentTenant: tenantContext?.currentTenant || { id: tenantId },
    currentTenantId: tenantId,
    currentTenantDescendantIds: Array.from(new Set(tenantContext?.currentTenantDescendantIds || [])),
    currentLegacyDataTenantIds: Array.from(new Set(tenantContext?.currentLegacyDataTenantIds || [])),
  };
}

function applyTenantScopeToWorkerFindOptions(options: any, collection: any, tenantContext?: ExportTenantContext) {
  const tenantId = tenantContext?.currentTenant?.id ?? tenantContext?.currentTenantId;

  if (!tenantId) {
    return options;
  }

  const tenancyMode = collection?.options?.tenancy || tenantContext.currentTenancyMode;

  if (tenancyMode !== 'tenantScoped' && tenancyMode !== 'tenantInherited') {
    return options;
  }

  const includeLegacyData = canReadLegacyData(tenantId, getLegacyDataTenantIds(tenantContext, collection));
  const tenantFilter =
    tenancyMode === 'tenantInherited'
      ? buildInheritedTenantFilter([tenantId, ...(tenantContext.currentTenantDescendantIds || [])], includeLegacyData)
      : buildTenantFilter(tenantId, includeLegacyData);

  return {
    ...options,
    filter: appendTenantFilter(options.filter, tenantFilter),
  };
}

export class ExportPlugin extends Plugin {
  beforeLoad() {}

  async load() {
    this.app.resourcer.registerActionHandler('export', exportXlsx);
    this.app.acl.setAvailableAction('export', {
      displayName: '{{t("Export")}}',
      allowConfigureFields: true,
    });
  }

  async install(options: InstallOptions) {}

  public static defaultSavePath = 'storage/uploads';

  xlsxStorageDir() {
    return path.resolve(process.env.TEGO_RUNTIME_HOME, ExportPlugin.defaultSavePath);
  }

  async workerExportXlsx(params) {
    const {
      title,
      filter,
      sort,
      fields,
      except,
      appends,
      resourceName,
      resourceOf,
      timezone,
      currentTenantId,
      tenantContext: rawTenantContext,
    } = params;
    let columns = params?.columns;
    if (typeof columns === 'string') {
      columns = JSON.parse(columns);
    }
    const repository = this.db.getRepository<any>(resourceName, resourceOf) as Repository;
    const collection = repository.collection;
    const tenantState = buildWorkerTenantState(currentTenantId, rawTenantContext);
    const tenantId = getExportTenantId({ state: tenantState });
    const tenantContext = tenantState
      ? {
          state: tenantState,
        }
      : undefined;
    const findOptions = applyTenantScopeToWorkerFindOptions(
      {
        filter,
        fields,
        appends,
        except,
        sort,
      },
      collection,
      tenantState,
    );
    columns = columns?.filter((col) => collection.hasField(col.dataIndex[0]) && col?.dataIndex?.length > 0);
    // 分页处理
    let page = 1;
    const pageSize = EXPORT_WORKER_PAGESIZE;
    let data = [];
    let hasMore = true;

    while (hasMore) {
      const pageData = await repository.find({
        ...findOptions,
        offset: (page - 1) * pageSize,
        limit: pageSize,
        context: tenantContext as any,
      });

      data = data.concat(pageData);
      hasMore = pageData.length === pageSize;
      page++;
    }
    const collectionFields = columns.map((col) => collection.fields.get(col.dataIndex[0]));
    const { rows, ranges } = await render({ columns, fields: collectionFields, data, utcOffset: timezone }, this.db);
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
    const stream = xlsx.build([
      {
        name: 'Sheet 1',
        data: rows,
        options: {
          '!merges': ranges,
        },
      },
    ]);
    const savePath = buildWorkerExportSavePath(this.xlsxStorageDir(), tenantId);
    if (!existsSync(savePath)) {
      mkdirSync(savePath, { recursive: true });
    }
    const fileName = buildWorkerExportFileName(resourceName, title, tenantId);
    const rawFile = `${savePath}/${fileName}`;
    writeFileSync(rawFile, Buffer.from(stream));
    return buildWorkerExportRelativePath(fileName, tenantId, ExportPlugin.defaultSavePath);
  }
}

export default ExportPlugin;
