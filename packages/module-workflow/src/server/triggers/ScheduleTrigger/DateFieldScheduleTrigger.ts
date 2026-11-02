import { fn, literal, Op, parseCollectionName, Transactionable, where } from '@tego/server';

import parser from 'cron-parser';

import { getDescendantTenantIds } from '../../helpers/tenant-context';
import type Plugin from '../../Plugin';
import type { WorkflowModel } from '../../types';
import { parseDateWithoutMs, SCHEDULE_MODE } from './utils';

export type ScheduleOnField = {
  field: string;
  // in seconds
  offset?: number;
  unit?: 1000 | 60000 | 3600000 | 86400000;
};

export interface ScheduleTriggerConfig {
  // trigger mode
  mode: number;
  // how to repeat
  repeat?: string | number | null;
  // limit of repeat times
  limit?: number;

  startsOn?: ScheduleOnField;
  endsOn?: string | ScheduleOnField;
}

function getOnTimestampWithOffset({ field, offset = 0, unit = 1000 }: ScheduleOnField, now: Date) {
  if (!field) {
    return null;
  }
  const timestamp = now.getTime();
  // onDate + offset > now
  // onDate > now - offset
  return timestamp - offset * unit;
}

function getDataOptionTime(record, on, dir = 1) {
  if (!on) {
    return null;
  }
  switch (typeof on) {
    case 'string': {
      const time = parseDateWithoutMs(on);
      return time ? time : null;
    }
    case 'object': {
      const { field, offset = 0, unit = 1000 } = on;
      if (!record.get(field)) {
        return null;
      }
      const second = new Date(record.get(field).getTime());
      second.setMilliseconds(0);
      return second.getTime() + offset * unit * dir;
    }
    default:
      return null;
  }
}

const DialectTimestampFnMap: { [key: string]: (col: string) => string } = {
  postgres(col) {
    return `CAST(FLOOR(extract(epoch from "${col}")) AS INTEGER)`;
  },
  mysql(col) {
    return `CAST(FLOOR(UNIX_TIMESTAMP(\`${col}\`)) AS SIGNED INTEGER)`;
  },
  sqlite(col) {
    return `CAST(FLOOR(unixepoch(${col})) AS INTEGER)`;
  },
};
DialectTimestampFnMap.mariadb = DialectTimestampFnMap.mysql;

function getCronNextTime(cron, currentDate: Date): number {
  const interval = parser.parseExpression(cron, { currentDate });
  const next = interval.next();
  return next.getTime();
}

function matchCronNextTime(cron, currentDate: Date, range: number): boolean {
  return getCronNextTime(cron, currentDate) - currentDate.getTime() <= range;
}

function getHookId(workflow, type: string) {
  return `${type}#${workflow.id}`;
}

function isTenantCollection(collection) {
  return collection?.options?.tenancy === 'tenantScoped' || collection?.options?.tenancy === 'tenantInherited';
}

function getLegacyDataTenantIds(collection): Array<string | number> {
  return Array.isArray(collection?.options?.legacyDataTenantIds) ? collection.options.legacyDataTenantIds : [];
}

async function buildTenantContext(db, collection, record, tenant?, descendantIdsCache = new Map<string, string[]>()) {
  const tenancyMode = collection?.options?.tenancy;
  if (!isTenantCollection(collection)) {
    return null;
  }

  const tenantId = tenant?.get?.('id') ?? record.get?.('tenantId') ?? record.tenantId;
  if (tenantId === null || tenantId === undefined) {
    return null;
  }

  let descendantIds: string[] = [];
  if (tenancyMode === 'tenantInherited' && db.getRepository('tenants')) {
    const cacheKey = `${tenantId}`;
    if (!descendantIdsCache.has(cacheKey)) {
      descendantIdsCache.set(
        cacheKey,
        await getDescendantTenantIds(db, cacheKey, { enabledOnly: true, useMaster: true, transaction: null }),
      );
    }
    descendantIds = descendantIdsCache.get(cacheKey) || [];
  }

  return {
    state: {
      currentTenant: tenant?.toJSON?.() ?? { id: tenantId },
      currentTenantId: tenantId,
      currentTenantDescendantIds: descendantIds,
      currentLegacyDataTenantIds: getLegacyDataTenantIds(collection),
      currentTenancyMode: tenancyMode,
    },
  };
}

async function buildEnabledTenantContext(db, collection, record) {
  if (!isTenantCollection(collection)) {
    return null;
  }

  const tenantId = record.get?.('tenantId') ?? record.tenantId;
  if (tenantId === null || tenantId === undefined || !db.getRepository('tenants')) {
    return null;
  }

  const tenant = await db.getRepository('tenants').findOne({
    useMaster: true,
    transaction: null,
    filter: {
      id: tenantId,
      enabled: true,
    },
  });

  return tenant ? buildTenantContext(db, collection, record, tenant) : null;
}

function bindTenantContext(record, context) {
  if (context) {
    Object.defineProperty(record, '__workflowTenantContext', {
      value: context,
      configurable: true,
    });
  }
  return record;
}

function getBoundTenantContext(record) {
  return record.__workflowTenantContext;
}

export default class ScheduleTrigger {
  events = new Map();

  private timer: NodeJS.Timeout | null = null;

  private cache: Map<string, any> = new Map();

  private cancellations = new Map<string, object>();

  private inspections = new Map<string, object>();

  private captureCurrent(workflow: WorkflowModel) {
    const key = `${workflow.id}`;
    const token = this.cancellations.get(key);
    return () => this.cancellations.get(key) === token;
  }

  // caching workflows in range, default to 5min
  cacheCycle = 300_000;

  constructor(public workflow: Plugin) {
    workflow.app.on('afterStart', async () => {
      if (this.timer) {
        return;
      }

      this.timer = setInterval(() => this.reload(), this.cacheCycle);

      this.reload();
    });

    workflow.app.on('beforeStop', () => {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }

      for (const [key, timer] of this.cache.entries()) {
        clearTimeout(timer);
        this.cache.delete(key);
      }
    });
  }

  async reload() {
    const cancellations = new Map(this.cancellations);
    try {
      const WorkflowRepo = this.workflow.app.db.getRepository('workflows');
      const workflows = await WorkflowRepo.find({
        filter: { enabled: true, type: 'schedule', 'config.mode': SCHEDULE_MODE.DATE_FIELD },
      });

      // Keep live handles cancellable; schedule deduplicates and fired callbacks retire them.
      await this.inspect(
        workflows.filter(
          (workflow) => this.cancellations.get(`${workflow.id}`) === cancellations.get(`${workflow.id}`),
        ),
      );
    } catch (error) {
      this.workflow.getLogger('dispatcher').error('failed to reload date-field schedules', error);
    }
  }

  async inspect(workflows: WorkflowModel[]): Promise<void> {
    const now = new Date();

    await Promise.all(
      workflows.map(async (workflow) => {
        const isCurrent = this.captureCurrent(workflow);
        const key = `${workflow.id}`;
        const inspection = {};
        this.inspections.set(key, inspection);
        try {
          const records = await this.loadRecordsToSchedule(workflow, now);
          for (const record of records) {
            if (!isCurrent() || this.inspections.get(key) !== inspection) return;
            const nextTime = this.getRecordNextTime(workflow, record, false, now);
            // Refresh only successfully discovered records; failed scans keep their live handles.
            this.schedule(workflow, record, nextTime, false);
            if (nextTime) await this.schedule(workflow, record, nextTime, true);
          }
        } catch (error) {
          this.workflow.getLogger(workflow.id).error('failed to inspect scheduled records', error);
        } finally {
          if (this.inspections.get(key) === inspection) this.inspections.delete(key);
        }
      }),
    );
  }

  // 1. startsOn in range -> yes
  // 2. startsOn before now, has no repeat -> no
  // 3. startsOn before now, and has repeat:
  //   a. repeat out of range -> no
  //   b. repeat in range (number or cron):
  //     i. endsOn after now -> yes
  //     ii. endsOn before now -> no
  async loadRecordsToSchedule(
    { config: { collection, limit, startsOn, repeat, endsOn }, allExecuted }: WorkflowModel,
    currentDate: Date,
  ) {
    const { db } = this.workflow.app;
    if (limit && allExecuted >= limit) {
      return [];
    }
    if (!startsOn) {
      return [];
    }
    const timestamp = currentDate.getTime();

    const startTimestamp = getOnTimestampWithOffset(startsOn, currentDate);
    if (!startTimestamp) {
      return [];
    }

    const range = this.cacheCycle * 2;
    const [dataSourceName, collectionName] = parseCollectionName(collection);
    const targetCollection = this.workflow.app.dataSourceManager.dataSources
      .get(dataSourceName)
      ?.collectionManager.getCollection(collectionName);
    if (!targetCollection) {
      throw new Error('Scheduled collection is unavailable in its configured data source');
    }

    const conditions: any[] = [
      {
        [startsOn.field]: {
          // cache next 2 cycles
          [Op.lt]: new Date(startTimestamp + range),
        },
      },
    ];

    if (repeat) {
      // when repeat is number, means repeat after startsOn
      // (now - startsOn) % repeat <= cacheCycle
      if (typeof repeat === 'number') {
        const tsFn = DialectTimestampFnMap[targetCollection.model.sequelize.getDialect()];
        if (repeat > range && tsFn) {
          const modExp = fn(
            'MOD',
            literal(`${Math.round(timestamp / 1000)} - ${tsFn(startsOn.field)}`),
            Math.round(repeat / 1000),
          );
          conditions.push(where(modExp, { [Op.lt]: Math.round(range / 1000) }));
        }
      } else if (typeof repeat === 'string') {
        if (!matchCronNextTime(repeat, currentDate, range)) {
          return [];
        }
      }

      if (endsOn) {
        const now = new Date();
        const endTimestamp = getOnTimestampWithOffset(endsOn, now);
        if (!endTimestamp) {
          return [];
        }
        if (typeof endsOn === 'string') {
          if (endTimestamp <= timestamp) {
            return [];
          }
        } else {
          conditions.push({
            [endsOn.field]: {
              [Op.gte]: new Date(endTimestamp),
            },
          });
        }
      }
    } else {
      conditions.push({
        [startsOn.field]: {
          [Op.gte]: new Date(startTimestamp),
        },
      });
    }

    const { model } = targetCollection;
    const records = await model.findAll({
      where: {
        [Op.and]: conditions,
      },
    });

    if (!isTenantCollection(targetCollection)) {
      return records;
    }

    const legacyDataTenantIds = getLegacyDataTenantIds(targetCollection);
    const hasLegacyRecords = records.some((record) => {
      const tenantId = record.get('tenantId');
      return tenantId === null || tenantId === undefined;
    });
    const tenantIdSet = new Set(records.map((record) => record.get('tenantId')).filter((tenantId) => tenantId != null));
    if (hasLegacyRecords) {
      legacyDataTenantIds.forEach((tenantId) => tenantIdSet.add(tenantId));
    }
    const tenantIds = Array.from(tenantIdSet);
    if (!tenantIds.length) {
      return [];
    }

    const tenants = await db.getRepository('tenants').find({
      useMaster: true,
      transaction: null,
      filter: {
        id: tenantIds,
        enabled: true,
      },
    });
    const tenantsById = new Map(tenants.map((tenant) => [`${tenant.get('id')}`, tenant]));
    const descendantIdsCache = new Map<string, string[]>();

    const recordsWithTenantContext = await Promise.all(
      records.map(async (record) => {
        const tenantId = record.get('tenantId');
        const tenant =
          tenantId === null || tenantId === undefined
            ? legacyDataTenantIds.map((id) => tenantsById.get(`${id}`)).find(Boolean)
            : tenantsById.get(`${tenantId}`);
        if (!tenant) {
          return null;
        }

        return bindTenantContext(
          record,
          await buildTenantContext(db, targetCollection, record, tenant, descendantIdsCache),
        );
      }),
    );

    return recordsWithTenantContext.filter((record) => record && getBoundTenantContext(record));
  }

  getRecordNextTime(workflow: WorkflowModel, record, nextSecond = false, currentDate = new Date(), savedAt?: Date) {
    const {
      config: { startsOn, endsOn, repeat, limit },
      allExecuted,
    } = workflow;
    if (limit && allExecuted >= limit) {
      return null;
    }
    const range = this.cacheCycle;
    const now = new Date(currentDate);
    now.setMilliseconds(nextSecond ? 1000 : 0);
    const timestamp = now.getTime();
    const startTime = getDataOptionTime(record, startsOn);
    const endTime = getDataOptionTime(record, endsOn);
    let nextTime = null;
    if (!startTime) {
      return null;
    }
    if (startTime > timestamp + range) {
      return null;
    }
    if (startTime >= timestamp) {
      return !endTime || (endTime >= startTime && endTime < timestamp + range) ? startTime : null;
    } else {
      if (savedAt && startTime >= new Date(savedAt).setMilliseconds(0)) {
        return startTime;
      }
      if (!repeat) {
        return null;
      }
    }
    if (typeof repeat === 'number') {
      const nextRepeatTime = ((startTime - timestamp) % repeat) + repeat;
      if (nextRepeatTime > range) {
        return null;
      }
      if (endTime && endTime < timestamp + nextRepeatTime) {
        return null;
      }
      nextTime = timestamp + nextRepeatTime;
    } else if (typeof repeat === 'string') {
      nextTime = getCronNextTime(repeat, now);
      if (nextTime - timestamp > range) {
        return null;
      }
      if (endTime && endTime < nextTime) {
        return null;
      }
    }
    if (endTime && endTime <= timestamp) {
      return null;
    }
    return nextTime;
  }

  schedule(workflow: WorkflowModel, record, nextTime, toggle = true, options = {}) {
    const [dataSourceName, collectionName] = parseCollectionName(workflow.config.collection);
    const { filterTargetKey } = this.workflow.app.dataSourceManager.dataSources
      .get(dataSourceName)
      .collectionManager.getCollection(collectionName);
    const recordPk = record.get(filterTargetKey);
    if (toggle) {
      const nextInterval = Math.max(0, nextTime - Date.now());
      const key = `${workflow.id}:${recordPk}@${nextTime}`;

      if (!this.cache.has(key)) {
        if (nextInterval) {
          const isCurrent = this.captureCurrent(workflow);
          const timer = setTimeout(async () => {
            try {
              if (isCurrent()) await this.trigger(workflow, record, nextTime);
            } catch (error) {
              this.workflow.getLogger(workflow.id).error('failed to trigger scheduled record', error);
            } finally {
              if (this.cache.get(key) === timer) this.cache.delete(key);
            }
          }, nextInterval);
          this.cache.set(key, timer);
        } else {
          return this.trigger(workflow, record, nextTime, options);
        }
      }
    } else {
      for (const [key, timer] of this.cache.entries()) {
        if (key.startsWith(`${workflow.id}:${recordPk}@`)) {
          clearTimeout(timer);
          this.cache.delete(key);
        }
      }
    }
  }

  async trigger(workflow: WorkflowModel, record, nextTime, { transaction }: Transactionable = {}) {
    const isCurrent = this.captureCurrent(workflow);
    const [dataSourceName, collectionName] = parseCollectionName(workflow.config.collection);
    const collection = this.workflow.app.dataSourceManager.dataSources
      .get(dataSourceName)
      .collectionManager.getCollection(collectionName);
    const { repository, filterTargetKey } = collection;
    const recordPk = record.get(filterTargetKey);
    const tenantAware = isTenantCollection(collection);
    // Savepoints keep the root connection; useMaster cannot move a read-pool transaction.
    type RoutedTransaction = Transactionable['transaction'] & {
      options?: { readOnly?: boolean };
      parent?: RoutedTransaction;
    };
    let rootTransaction = transaction as RoutedTransaction;
    while (rootTransaction?.parent) rootTransaction = rootTransaction.parent;
    if (tenantAware && rootTransaction?.options?.readOnly && collection.model?.sequelize.options.replication) return;
    const recordedOwner = tenantAware ? (record.get?.('tenantId') ?? record.tenantId ?? null) : undefined;
    let context = getBoundTenantContext(record);
    if (tenantAware) {
      // Inherited visibility at save time does not make the operator the task owner.
      const tenantId = recordedOwner ?? context?.state?.currentTenantId;
      if (tenantId === null || tenantId === undefined) {
        return;
      }

      const tenant = await this.workflow.app.db.getRepository('tenants').findOne({
        useMaster: true,
        transaction: null,
        filter: {
          id: tenantId,
          enabled: true,
        },
      });
      if (!tenant || !isCurrent()) {
        return;
      }

      context = await buildTenantContext(this.workflow.app.db, collection, record, tenant);
    } else {
      context = context || (await buildTenantContext(this.workflow.app.db, collection, record));
    }
    if (!isCurrent()) return;
    const data = await repository.findOne({
      filterByTk: recordPk,
      appends: workflow.config.appends,
      context,
      transaction: tenantAware ? (transaction ?? null) : transaction,
      ...(tenantAware ? { useMaster: true } : {}),
    });
    if (!data || !isCurrent()) {
      return;
    }
    if (tenantAware) {
      const currentOwner = data.get?.('tenantId') ?? data.tenantId ?? null;
      // A completed claim or ownership change invalidates the cached dispatch context.
      if ((currentOwner === null ? null : `${currentOwner}`) !== (recordedOwner === null ? null : `${recordedOwner}`)) {
        return;
      }
    }
    bindTenantContext(data, context);
    this.workflow.trigger(
      workflow,
      {
        data: data.toJSON(),
        date: new Date(nextTime),
        state: context?.state,
      },
      { context, transaction },
    );

    if (!workflow.config.repeat || (workflow.config.limit && workflow.allExecuted >= workflow.config.limit - 1)) {
      return;
    }

    const n = this.getRecordNextTime(workflow, data, true);
    if (n) {
      this.schedule(workflow, data, n, true);
    }
  }

  on(workflow: WorkflowModel) {
    const isCurrent = this.captureCurrent(workflow);
    const { collection } = workflow.config;
    const [dataSourceName, collectionName] = parseCollectionName(collection);
    const event = `${collectionName}.afterSaveWithAssociations`;
    const name = getHookId(workflow, event);
    if (this.events.has(name)) {
      this.inspect([workflow]);
      return;
    }

    const listener = async (data, { transaction, context }) => {
      const eventTime = new Date();
      const savedAt = data.get?.('updatedAt') ?? data.updatedAt ?? eventTime;
      const collection = this.workflow.app.dataSourceManager.dataSources
        .get(dataSourceName)
        .collectionManager.getCollection(collectionName);
      const tenantContext = context || (await buildEnabledTenantContext(this.workflow.app.db, collection, data));
      if (!isCurrent()) return;
      if (isTenantCollection(collection) && !tenantContext) {
        return;
      }
      bindTenantContext(data, tenantContext);
      const nextTime = this.getRecordNextTime(workflow, data, false, eventTime, savedAt);
      return this.schedule(workflow, data, nextTime, Boolean(nextTime), { transaction });
    };

    this.events.set(name, listener);
    // @ts-ignore
    this.workflow.app.dataSourceManager.dataSources.get(dataSourceName).collectionManager.db.on(event, listener);
    this.inspect([workflow]);
  }

  off(workflow: WorkflowModel) {
    // Invalidate calls already waiting on discovery, tenant facts or business data.
    this.cancellations.set(`${workflow.id}`, {});
    for (const [key, timer] of this.cache.entries()) {
      if (key.startsWith(`${workflow.id}:`)) {
        clearTimeout(timer);
        this.cache.delete(key);
      }
    }

    const { collection } = workflow.config;
    const [dataSourceName, collectionName] = parseCollectionName(collection);
    const event = `${collectionName}.afterSaveWithAssociations`;
    const name = getHookId(workflow, event);
    if (this.events.has(name)) {
      const listener = this.events.get(name);
      // @ts-ignore
      const { db } = this.workflow.app.dataSourceManager.dataSources.get(dataSourceName).collectionManager;
      db.off(event, listener);
      this.events.delete(name);
    }
  }
}
