import { Context } from '@tachybase/actions';

import { transaction } from 'packages/database/src/relation-repository/relation-repository';

import { TrackingFilter } from '../metrics/tracking-metrics/trackingFilter';
import { addDynamicMetric } from '../metrics/tracking-metrics/trackingMetrics';
import { trackingMetricsUtils } from '../utils/tracking-metrics-utils';

// 数据过滤工具函数

const operators = {
  $eq: (a, b) => a === b,
  $ne: (a, b) => a !== b,
  $gt: (a, b) => a > b,
  $gte: (a, b) => a >= b,
  $lt: (a, b) => a < b,
  $lte: (a, b) => a <= b,
  $in: (a, b) => a.includes(b),
  $exists: (a, b) => (b ? a !== undefined : a === undefined),
  $null: (a, b) => (b ? a === null : a !== null),
};

function getValueByPath(obj: any, path: string): any {
  if (!obj || !path) return undefined;

  return path.split('.').reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[key];
  }, obj);
}
function matchCondition(value, condition) {
  for (const op in condition) {
    const operator = op;
    if (operators[operator]) {
      if (!operators[operator](value, condition[op])) return false;
    } else {
      return false;
    }
  }
  return true;
}

function filterMatch(data: any, filter: Record<string, any>): boolean {
  try {
    if ('$and' in filter) {
      return filter['$and'].every((subFilter) => filterMatch(data, subFilter));
    }
    if ('$or' in filter) {
      return filter['$or'].some((subFilter) => filterMatch(data, subFilter));
    }
    for (const key in filter) {
      const value = filter[key];

      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const subKey in value) {
          const nested = value[subKey];

          const fullPath = `${key}.${subKey}`;
          const actualValue = getValueByPath(data, fullPath);

          if (!matchCondition(actualValue, nested)) {
            return false;
          }
        }
      } else {
        if (getValueByPath(data, key) !== value) {
          return false;
        }
      }
    }
    return true;
  } catch (error) {
    console.error('[TrackingMiddleware] 过滤匹配失败:', error);
    return false;
  }
}

// 从嵌套对象中提取指定键的值
function findValuesByKeys(obj: any, keys: string[]): Record<string, any> {
  const result: Record<string, any> = {};

  const traverse = (current: any) => {
    if (typeof current !== 'object' || current === null) return;

    for (const [k, v] of Object.entries(current)) {
      if (keys.includes(k)) {
        result[k] = v;
      }
      traverse(v);
    }
  };

  traverse(obj);
  return result;
}

// 创建追踪中间件
export function createTrackingMiddleware(trackingFilter: TrackingFilter) {
  return async (ctx: Context, next: () => Promise<any>) => {
    const startTime = Date.now();
    let status: 'success' | 'error' = 'success';
    let errorType: string | undefined;

    try {
      // 执行原始操作
      await next();

      // 检查是否需要追踪
      if (ctx.action) {
        const { actionName, resourceName } = ctx.action;

        if (trackingFilter.check(resourceName, actionName)) {
          const config = trackingFilter.getConfig(resourceName, actionName);
          if (config) {
            await processTracking(ctx, config, startTime, status);
          }
        }
      }
    } catch (error) {
      status = 'error';
      errorType = error.constructor.name;

      // 即使出错也要尝试追踪
      if (ctx.action) {
        const { actionName, resourceName } = ctx.action;

        if (trackingFilter.check(resourceName, actionName)) {
          const config = trackingFilter.getConfig(resourceName, actionName);
          if (config) {
            await processTracking(ctx, config, startTime, status, errorType);
          }
        }
      }

      throw error;
    }
  };
}

// 处理追踪逻辑
async function processTracking(
  ctx: Context,
  config: any,
  startTime: number,
  status: 'success' | 'error',
  errorType?: string,
) {
  try {
    const duration = Date.now() - startTime;
    // const userId = ctx.auth?.user?.id;
    const { params } = ctx.action;
    const data = ctx.response?.body || null;

    // 提取配置的数据
    const configKeys = {
      meta: config.trackingOptions?.meta || [],
      payload: config.trackingOptions?.payload || [],
      filter: config.trackingOptions?.filter || {},
    };

    // // 构建追踪数据
    // const trackingData = {
    //   params,
    //   data,
    //   meta: {
    //     userId,
    //     createdAt: new Date().toISOString(),
    //     userAgent: ctx.req?.headers?.['user-agent'],
    //   },
    // };

    const collection = ctx.app.mainDataSource.collectionManager.getCollection(ctx.action.resourceName);
    const currentRecordId = ctx.body?.[collection?.filterTargetKey] || null;
    const userId = ctx.auth?.user?.id || null;
    const currentTime = new Date().toISOString();
    const currentUserDevice = ctx.req?.headers?.['user-agent'] || null;

    const baseValues: Record<string, any> = {};
    if (configKeys.meta.includes('userId')) baseValues.userId = userId;
    if (configKeys.meta.includes('recordId')) baseValues.recordId = currentRecordId;
    if (configKeys.meta.includes('createdAt')) baseValues.createdAt = currentTime;
    if (configKeys.meta.includes('user-agent')) baseValues.userAgent = currentUserDevice;

    const nestedValuesMap = findValuesByKeys({ params, data }, configKeys.payload);

    const finalValues = {
      meta: baseValues,
      payload: Object.fromEntries(
        Object.entries(nestedValuesMap).map(([key, value]) => [
          key,
          Array.isArray(value) && value.length === 1 ? value[0] : value,
        ]),
      ),
    };
    // 检查过滤条件
    if (filterMatch(finalValues, configKeys.filter)) {
      // 记录到 Prometheus metrics
      trackingMetricsUtils.recordActionExecution(config, status, duration, userId, errorType);

      console.log(`[TrackingMiddleware] 记录操作追踪: ${config.title}, 状态: ${status}, 时长: ${duration}ms`);
    }
  } catch (error) {
    console.error('[TrackingMiddleware] 处理追踪失败:', error);
  }
}

// 初始化默认追踪配置
export async function initializeDefaultTrackingConfig(db: any) {
  try {
    const SignInTracking = await db.getRepository('metricsConfig').findOne({
      filter: {
        title: 'sign_in',
        type: 'Counter',
        resourceName: 'auth',
        action: 'signIn',
      },
    });

    if (!SignInTracking) {
      await db.getRepository('metricsConfig').create({
        values: {
          title: 'sign_in',
          help: '登录操作',
          type: 'Counter',
          resourceName: 'auth',
          action: 'signIn',
          enabled: true,
          trackingOptions: {
            meta: ['userId', 'createdAt', 'user-agent'],
            filter: {
              $and: [
                {
                  payload: {
                    errors: {
                      $exists: false,
                    },
                  },
                },
              ],
            },
            payload: ['errors', 'account', 'phone'],
          },
        },
      });
      console.log('[TrackingMiddleware] 已创建默认登录追踪配置');
    }
  } catch (error) {
    console.error('[TrackingMiddleware] 初始化默认追踪配置失败:', error);
  }
}

export async function initializeDefaultTrackingMetrics(db: any) {
  try {
    const allMetricsConfigs = await db.getRepository('metricsConfig').find();
    for (const config of allMetricsConfigs) {
      addDynamicMetric(config);
    }
  } catch (error) {
    console.error('[TrackingMiddleware] 初始化默认追踪配置失败:', error);
  }
}
