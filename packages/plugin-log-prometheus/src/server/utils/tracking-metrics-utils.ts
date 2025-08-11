import { formatDateTime } from '@tachybase/utils';

import client from 'prom-client';

import { register } from '../metrics/register';
import { trackingMetrics } from '../metrics/tracking-metrics/trackingMetrics';

// 追踪指标工具类
export class TrackingMetricsUtils {
  private static instance: TrackingMetricsUtils;

  static getInstance(): TrackingMetricsUtils {
    if (!TrackingMetricsUtils.instance) {
      TrackingMetricsUtils.instance = new TrackingMetricsUtils();
    }
    return TrackingMetricsUtils.instance;
  }

  // 更新追踪配置计数
  updateTrackingConfigCount(enabledCount: number, totalCount: number) {
    trackingMetrics.trackingConfigCount.set({ status: 'enabled' }, enabledCount);
    trackingMetrics.trackingConfigCount.set({ status: 'total' }, totalCount);
  }

  // 记录操作执行
  recordActionExecution(
    config: any,
    status: 'success' | 'error' = 'success',
    duration?: number,
    userId?: string,
    errorType?: string,
  ) {
    const today = formatDateTime(new Date(), 'YYYY-MM-DD');
    const labels = {
      config_title: config.title || '',
      resource_name: config.resourceName || '',
      action_name: config.action || '',
      status,
    };
    const baesLabels = {
      date: today || '',
      status,
    };

    const metric = trackingMetrics[`tracking_${config.title}`];
    if (!metric) {
      console.warn(`[recordActionExecution] 未找到动态指标实例: ${config.title}`);
    } else {
      // 判断指标类型，执行不同方法
      if (metric instanceof client.Counter) {
        metric.inc(baesLabels);
      } else if (metric instanceof client.Histogram) {
        if (duration !== undefined) {
          metric.observe(baesLabels, duration / 1000);
        }
      } else if (metric instanceof client.Gauge) {
        // Gauge 例子，这里根据业务定
        metric.set(baesLabels, 0);
      }
    }

    // 记录执行次数
    trackingMetrics.actionExecutionCount.inc(labels);

    // 记录执行时长
    if (duration !== undefined) {
      trackingMetrics.actionExecutionDuration.observe(
        {
          config_title: config.title,
          resource_name: config.resourceName,
          action_name: config.action,
        },
        duration / 1000,
      );
    }

    // 记录用户操作
    if (userId) {
      trackingMetrics.userActionFrequency.inc({
        user_id: userId,
        config_title: config.title,
        resource_name: config.resourceName,
        action_name: config.action,
      });
    }

    // 记录错误
    if (status === 'error' && errorType) {
      trackingMetrics.errorActionCount.inc({
        config_title: config.title,
        resource_name: config.resourceName,
        action_name: config.action,
        error_type: errorType,
      });
    }
  }

  // 记录批量操作
  recordBatchAction(config: any, count: number, status: 'success' | 'error' = 'success') {
    const labels = {
      config_title: config.title,
      resource_name: config.resourceName,
      action_name: config.action,
      status,
    };

    // 批量增加计数
    trackingMetrics.actionExecutionCount.inc(labels, count);
  }

  // 获取所有追踪指标
  async getTrackingMetrics(): Promise<string> {
    return await register.metrics();
  }

  // 获取追踪指标的 JSON 格式
  async getTrackingMetricsAsJSON(): Promise<any> {
    return await register.getMetricsAsJSON();
  }

  // 重置追踪指标
  resetTrackingMetrics(): void {
    register.clear();
  }
}

// 导出工具实例
export const trackingMetricsUtils = TrackingMetricsUtils.getInstance();
