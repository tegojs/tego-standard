import { EXECUTION_STATUS, PluginWorkflow, Processor } from '@tachybase/module-workflow';
import { App, Application, Database, Db, Inject, InjectLog, Logger, parseCollectionName, Service } from '@tego/server';

import parser from 'cron-parser';

import { DATABASE_CRON_JOBS, SCHEDULE_MODE } from '../../constants';
import { CronJobModel } from '../model/CronJobModel';
import { parseDateWithoutMs } from '../utils';
import { CronJobLock } from './CronJobLock';

const MAX_SAFE_INTERVAL = 2147483647;
const TENANT_ENABLED_MODES = new Set(['tenantScoped', 'tenantInherited']);

function isSuccessfulProcess(process: Processor | null | void) {
  if (process === undefined || process === null) {
    return false;
  }
  const processor = process as Processor;
  return processor.execution?.status === EXECUTION_STATUS.QUEUEING || processor.execution?.status >= 0;
}

@Service()
export class StaticScheduleTrigger {
  private static readonly inspectFields = ['startsOn', 'mode', 'endsOn', 'repeat', 'limit', 'enabled', 'limitExecuted'];
  @App()
  private app: Application;

  @Db()
  private readonly db: Database;

  @InjectLog()
  private readonly logger: Logger;

  @Inject(() => CronJobLock)
  private readonly cronJobLock: CronJobLock;

  private timers: Map<string, NodeJS.Timeout | null> = new Map();

  private async getTenantContexts(workflow) {
    const nodes = await workflow.getNodes();
    const collectionNames = new Set<string>();
    if (workflow.config?.collection) {
      collectionNames.add(workflow.config.collection);
    }
    for (const node of nodes) {
      if (node.config?.collection) {
        collectionNames.add(node.config.collection);
      }
    }

    const tenantCollections = Array.from(collectionNames)
      .map((name) => {
        const [dataSourceName, collectionName] = parseCollectionName(name);
        return this.app.dataSourceManager.dataSources
          .get(dataSourceName)
          ?.collectionManager.getCollection(collectionName);
      })
      .filter((collection) => TENANT_ENABLED_MODES.has(collection?.options?.tenancy));
    if (!tenantCollections.length) {
      return [null];
    }

    const tenants = await this.db.getRepository('tenants').find({
      filter: { enabled: true },
    });
    tenants.sort((left, right) => `${left.get('id')}`.localeCompare(`${right.get('id')}`));
    const legacyDataTenant = tenants.find((tenant) => tenant.get('parentId') == null) ?? tenants[0];
    const legacyDataTenantId = legacyDataTenant?.get('id');

    return tenants.map((tenant) => {
      const tenantId = tenant.get('id');
      return {
        state: {
          currentTenant: tenant.toJSON(),
          currentTenantId: tenantId,
          currentTenantDescendantIds: [],
          currentLegacyDataTenantIds: tenantCollections.flatMap(
            (collection) => collection.options?.legacyDataTenantIds ?? [],
          ),
          workflowExcludeLegacyData: `${tenantId}` !== `${legacyDataTenantId}`,
        },
      };
    });
  }

  async load() {
    this.app.on('afterStart', async (app) => {
      const cronJobs = await app.db.getRepository('cronJobs').find({
        filter: { mode: SCHEDULE_MODE.STATIC, enabled: true },
      });
      this.inspect(cronJobs);
    });

    this.app.on('beforeStop', () => {
      for (const timer of this.timers.values()) {
        clearInterval(timer);
      }
    });

    this.db.on(`${DATABASE_CRON_JOBS}.beforeSave`, async (cronjob: CronJobModel, options) => {
      // 仅监听部分字段变化
      let changed = false;
      for (const field of options.fields) {
        if (StaticScheduleTrigger.inspectFields.includes(field)) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        return;
      }
      this.off(cronjob);
    });

    this.db.on(`${DATABASE_CRON_JOBS}.afterSave`, async (cronjob: CronJobModel, options) => {
      // 仅监听部分字段变化
      let changed = false;
      for (const field of options.fields) {
        if (StaticScheduleTrigger.inspectFields.includes(field)) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        return;
      }
      if (cronjob.get('enabled')) {
        this.on(cronjob);
      }
    });

    this.db.on(`${DATABASE_CRON_JOBS}.afterDestroy`, async (cronjob) => {
      this.off(cronjob);
    });

    this.app.resourcer.use(
      async (ctx, next) => {
        const { resourceName, actionName } = ctx.action;
        await next();
        if (resourceName === 'cronJobs' && actionName === 'list') {
          const rows = ctx.body.rows as CronJobModel[];
          rows.forEach((cronJob) => {
            if (!cronJob.enabled) {
              return;
            }
            const nextTime = this.getNextTime(cronJob, new Date());
            if (nextTime) {
              cronJob.nextTime = new Date(nextTime);
            }
          });
        }
      },
      { tag: 'addNextTimeToCronJobs' },
    );
  }

  inspect(cronJobs: CronJobModel[]) {
    const now = new Date();

    cronJobs.forEach((cronJob) => {
      const nextTime = this.getNextTime(cronJob, now);
      if (nextTime) {
        this.logger.info(
          `cronJobs [${cronJob.id}] caching scheduled workflow [${cronJob.workflowKey}] will run at: ${new Date(nextTime).toISOString()}`,
        );
      } else {
        this.logger.info(`cronJobs [${cronJob.id}] workflow [${cronJob.workflowKey}] will not be scheduled`);
      }
      this.schedule(cronJob, nextTime, nextTime >= now.getTime());
    });
  }

  getNextTime(cronJob: CronJobModel, currentDate: Date, nextSecond = false) {
    if (cronJob.limit && cronJob.limitExecuted >= cronJob.limit) {
      return null;
    }
    if (!cronJob.startsOn) {
      return null;
    }
    currentDate.setMilliseconds(nextSecond ? 1000 : 0);
    const timestamp = currentDate.getTime();
    const startTime = parseDateWithoutMs(cronJob.startsOn);
    if (startTime > timestamp) {
      return startTime;
    }
    if (cronJob.repeat) {
      const endTime = cronJob.endsOn ? parseDateWithoutMs(cronJob.endsOn) : null;
      if (endTime && endTime < timestamp) {
        return null;
      }
      if (cronJob.repeat && isNaN(+cronJob.repeat)) {
        const interval = parser.parseExpression(cronJob.repeat, { currentDate });
        const next = interval.next();
        return next.getTime();
      } else if (!isNaN(+cronJob.repeat)) {
        const repeat = +cronJob.repeat;
        const next = timestamp + repeat - ((timestamp - startTime) % repeat);
        return next;
      } else {
        return null;
      }
    } else {
      if (startTime < timestamp) {
        return null;
      }
      return timestamp;
    }
  }

  schedule(cronJob: CronJobModel, nextTime: number, toggle = true) {
    if (toggle) {
      const key = `${cronJob.id}@${nextTime}`;
      if (!this.timers.has(key)) {
        const interval = Math.max(nextTime - Date.now(), 0);
        if (interval > MAX_SAFE_INTERVAL) {
          this.timers.set(
            key,
            setTimeout(() => {
              this.timers.delete(key);
              this.schedule(cronJob, nextTime);
            }, MAX_SAFE_INTERVAL),
          );
        } else {
          this.timers.set(key, setTimeout(this.trigger.bind(this, cronJob.id, nextTime), interval));
        }
      }
    } else {
      for (const [key, timer] of this.timers.entries()) {
        if (key.startsWith(`${cronJob.id}@`)) {
          clearTimeout(timer);
          this.timers.delete(key);
        }
      }
    }
  }

  async trigger(cronJobId: number, time: number) {
    const eventKey = `${cronJobId}@${time}`;

    try {
      // 尝试获取分布式锁，防止多节点重复执行
      const lockAcquired = await this.cronJobLock.acquire(cronJobId, time);
      if (!lockAcquired) {
        this.logger.info(
          `cronJobs [${cronJobId}] skipped: lock not acquired (another node is executing this job at ${new Date(time).toISOString()})`,
        );
        this.timers.delete(eventKey);
        return;
      }

      const cronJob = (await this.db
        .getRepository(DATABASE_CRON_JOBS)
        .findOne({ filterByTk: cronJobId })) as CronJobModel;

      if (!cronJob) {
        this.logger.warn(`Scheduled cron job ${cronJobId} no longer exists`);
        this.timers.delete(eventKey);
        await this.cronJobLock.release(cronJobId, time);
        return;
      }

      this.timers.delete(eventKey);

      // TODO: 保存pluginWorkflow
      const pluginWorkflow = this.app.pm.get(PluginWorkflow) as PluginWorkflow;

      const workflow = await this.db.getRepository('workflows').findOne({
        filter: { key: cronJob.workflowKey, enabled: true },
      });
      if (!workflow) {
        await this.cronJobLock.release(cronJobId, time);
        return;
      }

      let error = null;
      const processes: Array<Processor | null | void> = [];
      try {
        const tenantContexts = await this.getTenantContexts(workflow);
        for (const context of tenantContexts) {
          const tenantId = context?.state?.currentTenantId;
          const tenantEventKey = tenantId == null ? eventKey : `${eventKey}@${tenantId}`;
          try {
            processes.push(
              await pluginWorkflow.trigger(
                workflow,
                { date: new Date(time), state: context?.state },
                { context, eventKey: tenantEventKey },
              ),
            );
          } catch (e) {
            error = error || e;
            this.logger.error(
              `cronJobs [${cronJob.id}] workflow [${cronJob.workflowKey}] tenant [${tenantId}] failed: ${e.message}`,
            );
          }
        }
      } catch (e) {
        error = e;
        this.logger.error(`cronJobs [${cronJob.id}] workflow [${cronJob.workflowKey}] failed: ${e.message}`);
      } finally {
        const allProcessesSucceeded =
          processes.length > 0 && processes.every((process) => isSuccessfulProcess(process));
        if (!error && allProcessesSucceeded) {
          await cronJob.increment(['limitExecuted', 'allExecuted', 'successExecuted']);
          await cronJob.update({
            lastTime: new Date(time),
          });
        } else {
          await cronJob.increment(['limitExecuted', 'allExecuted']);
          await cronJob.update({
            lastTime: new Date(time),
          });
        }
        this.scheduleNextIfNeeded(cronJob);
        // 释放锁
        await this.cronJobLock.release(cronJobId, time);
      }
    } catch (e) {
      this.logger.error(`cronJobs [${cronJobId}] failed: ${e?.message ?? String(e)}`);
    }
  }

  /**
   * 如果需要，调度下一次执行
   */
  private scheduleNextIfNeeded(cronJob: CronJobModel) {
    if (!cronJob) {
      return;
    }
    if (!cronJob.repeat || (cronJob.limit && cronJob.limitExecuted >= cronJob.limit)) {
      return;
    }

    const nextTime = this.getNextTime(cronJob, new Date(), true);
    if (nextTime) {
      this.schedule(cronJob, nextTime);
    }
  }

  on(cronJob: CronJobModel) {
    this.inspect([cronJob]);
  }

  off(cronJob: CronJobModel) {
    this.schedule(cronJob, null, false);
  }
}
