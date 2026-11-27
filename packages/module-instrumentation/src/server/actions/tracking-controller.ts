import { Action, Context, Controller, Next, type Filter, type Repository } from '@tego/server';

import { getDailyActiveUser } from '../hooks/getActiveUser';
import { getDataByEventFrequency } from '../hooks/getQueryResult';
import { countDataByEventFrequency, groupDataByTime } from '../hooks/getStatistics';
import { ModuleInstrumentationServer } from '../plugin';

@Controller('instrumentation')
export class TrackingController {
  @Action('create', { acl: 'public' })
  async create(ctx: Context, next: () => Promise<any>) {
    const repo = await ctx.db.getRepository('trackingEvents');
    const version = process.env.npm_package_version;
    const currentTime = new Date().toISOString();
    const currentUserId = ctx.auth?.user?.id || null;
    const values = ctx.action.params.values.values
      ? {
          ...ctx.action.params.values,
          values: {
            meta: {
              userId: currentUserId,
              createdAt: currentTime,
            },
            payload: {
              ...ctx.action.params.values.values,
              version,
            },
          },
        }
      : { ...ctx.action.params.values, createdAt: currentTime };
    await repo.create({
      values,
    });
    return next();
  }

  @Action('list', { acl: 'private' })
  async list(ctx: Context, next: () => Promise<any>) {
    const userCount = await ctx.db.getRepository('users').count();
    const ActiveUsers = await getDailyActiveUser(ctx);
    const allData = await ctx.db.getRepository('trackingEvents').find();
    const configs = await ctx.db.getRepository('statisticsConfig').find();
    const historyConfigs = await ctx.db.getRepository('trackingHistoryOptions').find();
    let customData = {};
    let customDataByTime = {};
    for (const config of configs) {
      if (config.statisticsOptions?.collection) {
        const countFailed = (error: Error) => {
          console.error(
            `Error fetching count for collection "${config.statisticsOptions?.collection}":`,
            error.message,
          );
          customData[config.title] = 0;
        };
        let target: { collectionName: string; repository: Repository; filter: Filter };
        try {
          const collectionName = config.statisticsOptions.collection.trim();
          if (!collectionName) {
            throw new Error('Collection name is empty or invalid.');
          }

          const collectionFilter = config.statisticsOptions.collectionFilter;
          if (collectionFilter && typeof collectionFilter !== 'object') {
            throw new Error('Collection filter is invalid. It must be an object.');
          }

          target = { collectionName, repository: ctx.db.getRepository(collectionName), filter: collectionFilter || {} };
        } catch (error) {
          countFailed(error);
          continue;
        }
        // Authorization failures must escape the legacy SQL-error-to-zero fallback.
        // 授权拒绝必须向上传播，不能被原 SQL 错误回退吞成零。
        const plugin = ctx.tego.getPlugin(ModuleInstrumentationServer) as ModuleInstrumentationServer;
        const guarded = plugin.assertCollectionCount(
          Object.freeze({
            dataSourceName: 'main',
            collectionName: target.collectionName,
            collection: target.repository.collection,
            params: Object.freeze({ filter: target.filter }),
            context: ctx,
          }),
        );
        if (guarded !== undefined) await guarded;
        try {
          customData[config.title] = await target.repository.count({ filter: target.filter });
        } catch (error) {
          countFailed(error);
        }
      } else {
        // if (config.statisticsOptions?.timeGroup) {
        //   const grouped = groupDataByTime(allData, config.statisticsOptions);
        //   customDataByTime[config.title] = grouped;
        // } else {
        const count = countDataByEventFrequency(allData, config.statisticsOptions);
        customData[config.title] = count;
        // }
      }
    }

    for (const historyConfig of historyConfigs) {
      if (historyConfig.historyOptions?.timeGroup) {
        const grouped = groupDataByTime(allData, historyConfig.historyOptions);
        customDataByTime[historyConfig.title] = grouped;
      }
    }

    const result = {
      users: { ...ActiveUsers, userCount },
      customData,
      customDataByTime,
    };
    ctx.body = result;
    return next();
  }

  @Action('query', { acl: 'private' })
  async query(ctx: Context, next: () => Promise<any>) {
    const { values: configs } = ctx.action.params;
    const allData = await ctx.db.getRepository('trackingEvents').find();
    const queryResult = getDataByEventFrequency(allData, configs);
    ctx.body = queryResult;
    return next();
  }
}
