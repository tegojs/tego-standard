import { Context } from '@tego/server';

import dayjs from 'dayjs';

/**
 * 获取 workflow 的实际数据（可能是 Model 或 JSON）
 */
export function getWorkflowData(workflow: any): { id?: number; key?: string } {
  return workflow && typeof workflow.toJSON === 'function' ? workflow.toJSON() : workflow;
}

/**
 * 查询单个 workflow 的最新执行时间（UTC ISO 格式）
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

    // 优先使用 workflowId（可以利用外键索引）
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
 * 为 workflow 对象设置最新执行时间
 */
export function setLatestExecutedTime(row: any, executedTime: string | null) {
  (row as any).latestExecutedTime = executedTime;
  if (row && typeof row.setDataValue === 'function') {
    row.setDataValue('latestExecutedTime', executedTime);
  }
}

/**
 * 查询单个 workflow 的事件源名称
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
 * 为 workflow 对象设置事件源名称
 */
export function setEventSourceName(row: any, eventSourceName: string | null) {
  (row as any).eventSourceName = eventSourceName;
  if (row && typeof row.setDataValue === 'function') {
    row.setDataValue('eventSourceName', eventSourceName);
  }
}

/**
 * 查询单个 workflow 的分类信息
 * 如果 workflow 对象已经包含 category 数据（通过 appends），则直接使用
 */
export async function getCategoriesForWorkflow(
  context: Context,
  workflow?: any,
  workflowKey?: string,
): Promise<Array<{ id: number; name: string; color?: string }> | null> {
  // 优先从 workflow 对象中获取已加载的分类数据
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
 * 为 workflow 对象设置分类信息
 */
export function setCategories(row: any, categories: Array<{ id: number; name: string; color?: string }> | null) {
  (row as any).category = categories || [];
  if (row && typeof row.setDataValue === 'function') {
    row.setDataValue('category', categories || []);
  }
}
