import { actions, Context, Next, Op, Repository, utils } from '@tego/server';

import Plugin from '../Plugin';
import { WorkflowModel } from '../types';
import { triggerWorkflowAndGetExecution } from '../utils';
import {
  getCategoriesForWorkflow,
  getEventSourceNameForWorkflow,
  getLatestExecutedTimeForWorkflow,
  getWorkflowData,
  setCategories,
  setEventSourceName,
  setLatestExecutedTime,
} from './workflows.helpers';

/**
 * 扩展的 list action，在返回工作流列表时附加额外字段
 * - latestExecutedTime: 最新执行时间（UTC ISO 格式）
 * - eventSourceName: 关联的事件源名称
 * - category: 分类信息数组
 *
 * 使用 listExtended 作为 action 名称，避免覆盖默认的 list，便于后续扩展
 */
export async function listExtended(ctx: Context, next: Next) {
  // 先执行默认的 list action 获取基础数据
  await actions.list(ctx, next);

  // 为每个工作流附加额外字段
  if (ctx.body?.rows && Array.isArray(ctx.body.rows) && ctx.body.rows.length > 0) {
    const workflows = ctx.body.rows as WorkflowModel[];

    for (let index = 0; index < workflows.length; index++) {
      const workflow = workflows[index];
      const row = ctx.body.rows[index];

      if (!row) continue;

      const workflowData = getWorkflowData(workflow);

      // 查询并附加最新执行时间
      const executedTime = await getLatestExecutedTimeForWorkflow(ctx, workflowData?.id, workflowData?.key);
      setLatestExecutedTime(row, executedTime);

      // 查询并附加事件源名称
      const eventSourceName = await getEventSourceNameForWorkflow(ctx, workflowData?.key);
      setEventSourceName(row, eventSourceName);

      // 查询并附加分类信息
      const categories = await getCategoriesForWorkflow(ctx, workflow, workflowData?.key);
      setCategories(row, categories);
    }
  }

  return ctx;
}

export async function update(ctx: Context, next) {
  const repository = utils.getRepositoryFromParams(ctx) as Repository;
  const { filterByTk, values } = ctx.action.params;
  ctx.action.mergeParams({
    whitelist: [
      'title',
      'description',
      'enabled',
      'triggerTitle',
      'config',
      'options',
      'type',
      'sync',
      'category',
      // TODO: 这里的 icon 和 color 是审批插件的特有字段，后续办法是在审批里覆盖这个方法, 以便分离扩展字段和核心字段
      'color',
      'icon',
    ],
  });
  // only enable/disable
  if (Object.keys(values).includes('config')) {
    const workflow = await repository.findById(filterByTk);
    if (workflow.get('executed')) {
      return ctx.throw(400, 'config of executed workflow can not be updated');
    }
  }
  return actions.update(ctx, next);
}

export async function destroy(ctx: Context, next) {
  const repository = utils.getRepositoryFromParams(ctx) as Repository;
  const { filterByTk, filter } = ctx.action.params;

  await ctx.db.sequelize.transaction(async (transaction) => {
    const items = await repository.find({
      filterByTk,
      filter,
      fields: ['id', 'key', 'current'],
      transaction,
    });
    const ids = new Set<number>(items.map((item) => item.id));
    const keysSet = new Set<string>(items.filter((item) => item.current).map((item) => item.key));
    const revisions = await repository.find({
      filter: {
        key: Array.from(keysSet),
        current: { [Op.not]: true },
      },
      fields: ['id'],
      transaction,
    });

    revisions.forEach((item) => ids.add(item.id));

    ctx.body = await repository.destroy({
      filterByTk: Array.from(ids),
      individualHooks: true,
      transaction,
    });
  });

  next();
}

export async function dump(ctx: Context, next: Next) {
  const repository = utils.getRepositoryFromParams(ctx);
  const { filterByTk, filter = {}, values = {} } = ctx.action.params;

  ctx.body = await ctx.db.sequelize.transaction(async (transaction) => {
    const origin = await repository.findOne({
      filterByTk,
      filter,
      appends: ['nodes'],
      context: ctx,
      transaction,
    });

    const revisionData = filter.key
      ? {
          key: filter.key,
          title: origin.title,
          triggerTitle: origin.triggerTitle,
          allExecuted: origin.allExecuted,
          sync: origin.sync,
          initAt: origin.initAt,
        }
      : values;

    const dumpOne = {
      ...origin.toJSON(),
      ...revisionData,
    };

    return dumpOne;
  });

  await next();
}

export async function load(ctx: Context, next: Next) {
  const plugin = ctx.tego.pm.get(Plugin);
  const repository = utils.getRepositoryFromParams(ctx);
  const { values = {} } = ctx.action.params;

  ctx.body = await ctx.db.sequelize.transaction(async (transaction) => {
    const origin = values.workflow;

    const trigger = plugin.triggers.get(origin.type);

    const instance = await repository.create({
      values: {
        title: values.title,
        description: origin.description,
        type: origin.type,
        triggerTitle: origin.triggerTitle,
        allExecuted: origin.allExecuted,
        sync: origin.sync,
        initAt: origin.initAt,
        config:
          typeof trigger.duplicateConfig === 'function'
            ? await trigger.duplicateConfig(origin, { transaction })
            : origin.config,
      },
      transaction,
    });

    const originalNodesMap = new Map();
    origin.nodes.forEach((node) => {
      originalNodesMap.set(node.id, node);
    });

    const oldToNew = new Map();
    const newToOld = new Map();
    for await (const node of origin.nodes) {
      const instruction = plugin.instructions.get(node.type);
      const newNode = await instance.createNode(
        {
          type: node.type,
          key: node.key,
          config:
            typeof instruction.duplicateConfig === 'function'
              ? await instruction.duplicateConfig(node, { transaction })
              : node.config,
          title: node.title,
          branchIndex: node.branchIndex,
        },
        { transaction },
      );
      // NOTE: keep original node references for later replacement
      oldToNew.set(node.id, newNode);
      newToOld.set(newNode.id, node);
    }

    for await (const [oldId, newNode] of oldToNew.entries()) {
      const oldNode = originalNodesMap.get(oldId);
      const newUpstream = oldNode.upstreamId ? oldToNew.get(oldNode.upstreamId) : null;
      const newDownstream = oldNode.downstreamId ? oldToNew.get(oldNode.downstreamId) : null;

      await newNode.update(
        {
          upstreamId: newUpstream?.id ?? null,
          downstreamId: newDownstream?.id ?? null,
        },
        { transaction },
      );
    }

    return instance;
  });

  await next();
}

export async function test(ctx: Context, next: Next) {
  const plugin = ctx.tego.pm.get(Plugin);
  const repository = utils.getRepositoryFromParams(ctx);
  const { filterByTk, filter = {}, values = {} } = ctx.action.params;

  if (!ctx.state) {
    ctx.state = {};
  }
  if (!ctx.state.messages) {
    ctx.state.messages = [];
  }

  const workflow = await repository.findOne({
    filterByTk,
    filter,
    appends: ['nodes'],
    context: ctx,
  });

  if (!workflow) {
    return ctx.throw(404, 'Workflow not found');
  }

  const execution = await triggerWorkflowAndGetExecution(
    plugin,
    workflow,
    {
      data: values.data || {},
      user: ctx?.state?.currentUser || {},
    },
    { httpContext: ctx, transaction: ctx.transaction },
    ctx.db,
  );

  if (!execution) {
    ctx.state.messages.push({
      message: ctx.t('Failed to create execution', { ns: 'workflow' }),
    });
    return ctx.throw(500, 'Failed to create execution');
  }

  ctx.state.messages.push({
    message: ctx.t('Test execution ended', { ns: 'workflow' }),
  });

  ctx.body = execution;
  await next();
}

export async function revision(ctx: Context, next: Next) {
  const plugin = ctx.tego.pm.get(Plugin);
  const repository = utils.getRepositoryFromParams(ctx);
  const { filterByTk, filter = {}, values = {} } = ctx.action.params;

  ctx.body = await ctx.db.sequelize.transaction(async (transaction) => {
    const origin = await repository.findOne({
      filterByTk,
      filter,
      appends: ['nodes'],
      context: ctx,
      transaction,
    });

    const trigger = plugin.triggers.get(origin.type);

    const revisionData = filter.key
      ? {
          key: filter.key,
          title: origin.title,
          triggerTitle: origin.triggerTitle,
          allExecuted: origin.allExecuted,
          sync: origin.sync,
          initAt: origin.initAt,
          ...values,
        }
      : values;

    const instance = await repository.create({
      values: {
        title: `${origin.title} copy`,
        description: origin.description,
        ...revisionData,
        type: origin.type,
        config:
          typeof trigger.duplicateConfig === 'function'
            ? await trigger.duplicateConfig(origin, { transaction })
            : origin.config,
      },
      transaction,
    });

    const originalNodesMap = new Map();
    origin.nodes.forEach((node) => {
      originalNodesMap.set(node.id, node);
    });

    const oldToNew = new Map();
    const newToOld = new Map();
    for await (const node of origin.nodes) {
      const instruction = plugin.instructions.get(node.type);
      const newNode = await instance.createNode(
        {
          type: node.type,
          key: node.key,
          config:
            typeof instruction.duplicateConfig === 'function'
              ? await instruction.duplicateConfig(node, { transaction })
              : node.config,
          title: node.title,
          branchIndex: node.branchIndex,
        },
        { transaction },
      );
      // NOTE: keep original node references for later replacement
      oldToNew.set(node.id, newNode);
      newToOld.set(newNode.id, node);
    }

    for await (const [oldId, newNode] of oldToNew.entries()) {
      const oldNode = originalNodesMap.get(oldId);
      const newUpstream = oldNode.upstreamId ? oldToNew.get(oldNode.upstreamId) : null;
      const newDownstream = oldNode.downstreamId ? oldToNew.get(oldNode.downstreamId) : null;

      await newNode.update(
        {
          upstreamId: newUpstream?.id ?? null,
          downstreamId: newDownstream?.id ?? null,
        },
        { transaction },
      );
    }

    return instance;
  });

  await next();
}

export async function retry(ctx: Context, next: Next) {
  const plugin = ctx.tego.pm.get(Plugin);
  const repository = utils.getRepositoryFromParams(ctx);
  const { filterByTk, filter = {}, values = {} } = ctx.action.params;
  const ExecutionRepo = ctx.db.getRepository('executions');

  if (!ctx.state) {
    ctx.state = {};
  }
  if (!ctx.state.messages) {
    ctx.state.messages = [];
  }
  const workflow = await repository.findOne({
    filterByTk,
    filter,
    appends: ['nodes'],
    context: ctx,
  });

  const execution = await ExecutionRepo.findOne({
    filter: { key: workflow.key },
    sort: ['-createdAt'],
  });
  if (!execution) {
    ctx.state.messages.push({
      message: ctx.t('No execution records found for this workflow.', { ns: 'workflow' }),
    });
  }

  try {
    const newExecution = await triggerWorkflowAndGetExecution(
      plugin,
      workflow,
      execution.context,
      { httpContext: ctx, transaction: ctx.transaction },
      ctx.db,
    );

    if (!newExecution) {
      ctx.state.messages.push({
        message: ctx.t('Failed to create execution', { ns: 'workflow' }),
      });
      ctx.body = {
        error: ctx.t('Failed to create execution', { ns: 'workflow' }),
      };
      return await next();
    }

    ctx.state.messages.push({ message: ctx.t('Execute ended', { ns: 'workflow' }) });
    ctx.body = newExecution;
  } catch (error) {
    ctx.tego.logger.error(`Failed to retry execution ${execution.id}: ${error.message}`);
    ctx.state.messages.push({
      message: ctx.t('Failed to retry execution', { ns: 'workflow' }),
      error: error.message,
    });
    ctx.body = {
      error: error.message,
    };
  }

  await next();
}

export async function sync(ctx: Context, next) {
  const plugin = ctx.tego.pm.get(Plugin);
  const repository = utils.getRepositoryFromParams(ctx);
  const { filterByTk, filter = {} } = ctx.action.params;

  const workflows = await repository.find({
    filterByTk,
    filter,
  });

  workflows.forEach((workflow) => {
    plugin.toggle(workflow, false);
    plugin.toggle(workflow);
  });

  ctx.status = 204;

  await next();
}

export async function trigger(ctx: Context, next: Next) {
  if (!ctx.action.params.triggerWorkflows) {
    const plugin = ctx.tego.getPlugin(Plugin) as Plugin;
    const workflow = (await ctx.db.getRepository('workflows').findById(ctx.action.params.filterByTk)) as WorkflowModel;
    // NOTE: 这里的updateData是通过前端传过来的，需要 decodeURIComponent,
    //  updateData 的约定结构是形如: updateData: { primaryKey: "id", targetKeys: []}
    const updateData = JSON.parse(decodeURIComponent(ctx.action.params?.updateData || ''));
    plugin.trigger(
      workflow,
      {
        data: {
          updateData,
          httpContext: ctx,
          user: ctx?.auth?.user,
        },
      },
      { httpContext: ctx },
    );
  } else {
    await next();
  }
}

export async function moveWorkflow(ctx: Context, next: Next) {
  const { id, targetKey } = ctx.action.params;
  if (!id || !targetKey) {
    ctx.throw(400, 'params error');
  }
  const workflowRepo = ctx.db.getRepository('workflows');
  // 为了防止出现问题,目标workflow必须是启用的
  const targetWorkflow = await workflowRepo.findOne({
    filter: {
      key: targetKey,
      enabled: true,
    },
  });
  if (!targetWorkflow) {
    ctx.throw(400, 'target workflow not found');
  }
  const sourceWorkflow = await workflowRepo.findOne({
    filter: {
      id,
    },
  });
  if (!sourceWorkflow) {
    ctx.throw(400, 'source workflow not found');
  }
  if (sourceWorkflow.key === targetKey) {
    ctx.throw(400, 'same workflow');
  }
  if (sourceWorkflow.current) {
    ctx.throw(400, 'cannot move current workflow');
  }
  if (sourceWorkflow.type !== targetWorkflow.type) {
    ctx.throw(400, 'the type is different');
  }
  const { allExecuted } = targetWorkflow;
  const transaction = await ctx.db.sequelize.transaction();
  await workflowRepo.update({
    values: { key: targetKey, current: null, allExecuted },
    filter: { id },
    hooks: false, // 不触发钩子
    transaction,
  });

  // 执行记录的key也要更新,方便查看执行记录
  const executionRepo = ctx.db.getRepository('executions');
  await executionRepo.update({
    values: { key: targetKey },
    filter: { workflow: { id } },
    silent: true, // 不修改updatedAt等数据
    hooks: false, // 不触发钩子
    transaction,
  });
  // 允许未启动/或者关闭approvals的也能平稳move
  const repo = ctx.db.getRepository('approvals');
  if (repo) {
    // resubmit就是workflow最新的,而不是move的那一份
    await repo.update({
      values: { workflowKey: targetKey },
      filter: { workflowId: id },
      hooks: false, // 不触发钩子
      transaction,
    });
  }
  await transaction.commit();
  ctx.body = {};
}
