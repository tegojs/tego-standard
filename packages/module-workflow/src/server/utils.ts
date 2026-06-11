import { Database, Model, Op, Transactionable } from '@tego/server';

import PluginWorkflowServer from './Plugin';
import { WorkflowModel } from './types';

export function toJSON(data: any): any {
  if (Array.isArray(data)) {
    return data.map(toJSON);
  }
  if (!(data instanceof Model) || !data) {
    return data;
  }
  const result = data.get();
  Object.keys((<typeof Model>data.constructor).associations).forEach((key) => {
    if (result[key] != null && typeof result[key] === 'object') {
      result[key] = toJSON(result[key]);
    }
  });
  return result;
}

/**
 * 触发工作流并获取新创建的执行记录
 * @param plugin 工作流插件实例
 * @param workflow 工作流模型
 * @param context 触发上下文
 * @param options 选项（包含 httpContext, transaction 等）
 * @param db 数据库实例（用于查询执行记录）
 * @returns 新创建的执行记录，如果创建失败则返回 null
 */
export async function triggerWorkflowAndGetExecution(
  plugin: PluginWorkflowServer,
  workflow: WorkflowModel,
  context: object,
  options: { httpContext?: any; transaction?: any } & Transactionable = {},
  db: Database,
): Promise<any | null> {
  // 记录触发前的时间，用于队列模式下查找新创建的执行记录
  const beforeTriggerTime = new Date();

  const result = await plugin.trigger(workflow, context, options);

  let execution;

  // 处理同步模式：result 是 Processor 对象，包含 execution 属性
  if (result && typeof result === 'object' && 'execution' in result && result.execution) {
    execution = result.execution;
  } else if (!result && !plugin.isWorkflowSync(workflow)) {
    // 队列模式：trigger 返回 void，需要等待执行记录创建
    // 重试机制：最多等待 2 秒，每 200ms 检查一次
    const ExecutionRepo = db.getRepository('executions');
    const maxRetries = 10;
    const retryDelay = 200;
    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      execution = await ExecutionRepo.findOne({
        filter: {
          key: workflow.key,
          createdAt: {
            [Op.gte]: beforeTriggerTime,
          },
        },
        sort: ['-createdAt'],
        transaction: options.transaction,
      });
      if (execution) {
        break;
      }
    }
  }

  return execution || null;
}
