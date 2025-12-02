import { actions, utils } from '@tego/server';

import { PluginWorkflow } from '../..';
import { COLLECTION_NOTICE_NAME, NOTICE_INSTRUCTION_NAMESPACE } from '../common/constants';
import { COLLECTION_WORKFLOWS_NAME } from './collections/workflowNotice';
import { NOTICE_ACTION_STATUS } from './constants';

const workflows = {
  async listWorkflowNoticeFlows(ctx, next) {
    ctx.action.mergeParams({
      filter: {
        type: NOTICE_INSTRUCTION_NAMESPACE,
        enabled: true,
      },
    });
    return actions.list(ctx, next);
  },
};

const workflowNotice = {
  async listCentralized(ctx, next) {
    const centralizedNoticeFlow = await ctx.db.getRepository(COLLECTION_WORKFLOWS_NAME).find({
      filter: {
        'config.centralized': true,
      },
      fields: ['id'],
    });
    ctx.action.mergeParams({
      filter: {
        workflowId: centralizedNoticeFlow.map((item) => item.id),
      },
    });
    return actions.list(ctx, next);
  },
  async submit(ctx, next) {
    const repository = utils.getRepositoryFromParams(ctx);
    const { filterByTk, values } = ctx.action.params;
    const { currentUser } = ctx.state;
    if (!currentUser) {
      return ctx.throw(401);
    }
    const workflowNotice = await repository.findOne({
      filterByTk,
      filter: {
        userId: currentUser == null ? void 0 : currentUser.id,
      },
      appends: ['job', 'node', 'execution', 'workflow'],
      context: ctx,
    });

    if (!workflowNotice) {
      return ctx.throw(404);
    }

    if (
      !workflowNotice.workflow.enabled ||
      workflowNotice.execution.status ||
      workflowNotice.job.status ||
      workflowNotice.status !== NOTICE_ACTION_STATUS.PENDING ||
      !(workflowNotice.node.config.actions ?? []).includes(values.status)
    ) {
      return ctx.throw(400);
    }

    // TODO: 完善这里的取值逻辑
    await workflowNotice.update({
      status: values.status,
      //   comment: values.comment,
      //   snapshot: workflowNotice.approval.data,
      //   summary: workflowNotice.approval.summary,
      //   collectionName: workflowNotice.approval.collectionName,
    });

    ctx.body = workflowNotice.get();
    ctx.status = 202;

    await next();

    workflowNotice.execution.workflow = workflowNotice.workflow;
    workflowNotice.job.execution = workflowNotice.execution;
    workflowNotice.job.latestUserJob = workflowNotice.get();
    const workflow = ctx.tego.pm.get(PluginWorkflow);
    const processor = workflow.createProcessor(workflowNotice.execution);

    processor.logger.info(
      `notice node (${workflowNotice.nodeId}) action trigger execution (${workflowNotice.execution.id}) to resume`,
    );
    workflow.resume(workflowNotice.job);
  },
};

export function init({ app }) {
  app.resourcer.registerActions({
    ...make(COLLECTION_WORKFLOWS_NAME, workflows),
    ...make(COLLECTION_NOTICE_NAME, workflowNotice),
  });
}

function make(name, mod) {
  return Object.keys(mod).reduce(
    (result, key) => ({
      ...result,
      [`${name}:${key}`]: mod[key],
    }),
    {},
  );
}
