import { Context } from '@tego/server';

import dayjs from 'dayjs';

/**
 * 获取工作流的实际数据（处理 Model 和 JSON 两种格式）
 */
export function getWorkflowData(workflow: any): { id?: number; key?: string } {
  return workflow && typeof workflow.toJSON === 'function' ? workflow.toJSON() : workflow;
}

/**
 * 查询单个工作流的最新执行时间
 * @param context 上下文对象
 * @param workflowId 工作流 ID（优先使用，可利用外键索引）
 * @param workflowKey 工作流 Key（备用）
 * @returns UTC ISO 格式的时间字符串，如果不存在则返回 null
 */
export async function getLatestExecutedTimeForWorkflow(
  context: Context,
  workflowId?: number,
  workflowKey?: string,
): Promise<string | null> {
  if (!workflowId && !workflowKey) {
    return null;
  }

  try {
    const ExecutionRepo = context.db.getRepository('executions');
    const filter: any = {};

    // 优先使用 workflowId（可以利用外键索引提高查询性能）
    if (workflowId) {
      filter.workflowId = workflowId;
    } else if (workflowKey) {
      filter.key = workflowKey;
    }

    const latestExecution = await ExecutionRepo.findOne({
      filter,
      fields: ['id', 'key', 'createdAt', 'workflowId'],
      sort: ['-createdAt'],
      context,
    });

    return latestExecution?.createdAt ? dayjs(latestExecution.createdAt).utc().toISOString() : null;
  } catch (error) {
    context.log.error('Failed to fetch latest executed time:', error);
    return null;
  }
}

/**
 * 为工作流对象设置最新执行时间
 * 支持 Model 和普通对象两种格式
 */
export function setLatestExecutedTime(row: any, executedTime: string | null) {
  (row as any).latestExecutedTime = executedTime;
  if (row && typeof row.setDataValue === 'function') {
    row.setDataValue('latestExecutedTime', executedTime);
  }
}

/**
 * 查询单个工作流关联的事件源名称
 * @param context 上下文对象
 * @param workflowKey 工作流 Key
 * @returns 事件源名称，如果不存在则返回 null
 */
export async function getEventSourceNameForWorkflow(context: Context, workflowKey?: string): Promise<string | null> {
  if (!workflowKey) {
    return null;
  }

  try {
    const WebhookRepo = context.db.getRepository('webhooks');
    const eventSource = await WebhookRepo.findOne({
      filter: { workflowKey },
      fields: ['id', 'name'],
      context,
    });

    return eventSource?.name || null;
  } catch (error) {
    context.log.error('Failed to fetch event source name:', error);
    return null;
  }
}

/**
 * 为工作流对象设置事件源名称
 * 支持 Model 和普通对象两种格式
 */
export function setEventSourceName(row: any, eventSourceName: string | null) {
  (row as any).eventSourceName = eventSourceName;
  if (row && typeof row.setDataValue === 'function') {
    row.setDataValue('eventSourceName', eventSourceName);
  }
}

/**
 * 查询单个工作流的分类信息
 * 优先从 workflow 对象中获取已加载的分类数据（通过 appends），如果不存在则查询数据库
 * @param context 上下文对象
 * @param workflow 工作流对象（可能包含已加载的分类数据）
 * @param workflowKey 工作流 Key（用于查询数据库）
 * @returns 分类信息数组，格式：{ id, name, color? }[]
 */
export async function getCategoriesForWorkflow(
  context: Context,
  workflow?: any,
  workflowKey?: string,
): Promise<Array<{ id: number; name: string; color?: string }> | null> {
  // 优先从 workflow 对象中获取已加载的分类数据（避免重复查询）
  if (workflow) {
    const workflowData = workflow && typeof workflow.toJSON === 'function' ? workflow.toJSON() : workflow;
    if ((workflowData as any)?.category && Array.isArray((workflowData as any).category)) {
      return (workflowData as any).category.map((cat: any) => {
        const data = cat && typeof cat.toJSON === 'function' ? cat.toJSON() : cat;
        return {
          id: data?.id,
          name: data?.name,
          color: data?.color,
        };
      });
    }
  }

  // 如果没有 workflowKey，无法查询
  const key = workflowKey || (workflow && getWorkflowData(workflow)?.key);
  if (!key) {
    return null;
  }

  try {
    const WorkflowCategoryRepo = context.db.getRepository('workflowCategory');
    const CategoryRepo = context.db.getRepository('workflowCategories');

    // 查询中间表获取分类 ID 列表
    const workflowCategories = await WorkflowCategoryRepo.find({
      filter: { workflowKey: key },
      fields: ['categoryId'],
      context,
    });

    if (!workflowCategories || workflowCategories.length === 0) {
      return [];
    }

    const categoryIds = workflowCategories
      .map((wc: any) => {
        const data = wc && typeof wc.toJSON === 'function' ? wc.toJSON() : wc;
        return data?.categoryId;
      })
      .filter(Boolean);

    if (categoryIds.length === 0) {
      return [];
    }

    // 查询分类详情
    const categories = await CategoryRepo.find({
      filter: { id: categoryIds },
      fields: ['id', 'name', 'color'],
      sort: ['sort'],
      context,
    });

    return categories.map((cat: any) => {
      const data = cat && typeof cat.toJSON === 'function' ? cat.toJSON() : cat;
      return {
        id: data?.id,
        name: data?.name,
        color: data?.color,
      };
    });
  } catch (error) {
    context.log.error('Failed to fetch categories:', error);
    return null;
  }
}

/**
 * 为工作流对象设置分类信息
 * 支持 Model 和普通对象两种格式
 */
export function setCategories(row: any, categories: Array<{ id: number; name: string; color?: string }> | null) {
  (row as any).category = categories || [];
  if (row && typeof row.setDataValue === 'function') {
    row.setDataValue('category', categories || []);
  }
}
