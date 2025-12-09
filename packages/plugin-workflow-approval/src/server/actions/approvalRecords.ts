import { PluginWorkflow } from '@tachybase/module-workflow';
import { actions, utils } from '@tego/server';

import { ERROR_CODE_MAP } from '../constants/error-code';
import { APPROVAL_ACTION_STATUS } from '../constants/status';

export const approvalRecords = {
  async listCentralized(ctx, next) {
    const centralizedApprovalFlow = await ctx.db.getRepository('workflows').find({
      filter: {
        type: 'approval',
        'config.centralized': true,
      },
      fields: ['id'],
    });
    ctx.action.mergeParams({
      filter: {
        workflowId: centralizedApprovalFlow.map((item) => item.id),
      },
    });

    return actions.list(ctx, next);
  },
  async submit(ctx, next) {
    const repository = utils.getRepositoryFromParams(ctx);
    const { filterByTk, values } = ctx.action.params;
    const { data, status, needUpdateRecord } = values || {};
    const { currentUser } = ctx.state;
    if (!currentUser) {
      return ctx.throw(401);
    }
    const approvalRecord = await repository.findOne({
      filterByTk,
      filter: {
        userId: currentUser == null ? void 0 : currentUser.id,
      },
      appends: ['job', 'node', 'execution', 'workflow', 'approval'],
      context: ctx,
    });
    if (!approvalRecord) {
      return ctx.throw(404);
    }

    // NOTE: 为了更改设定, 让切换版本后, 已经在进程中的审批流程也可以执行下去. 所以这里先注释掉.
    // 原设定是, 切换版本后, 已经在流程中的, 置为未处理状态, 然后禁止继续执行.
    switch (true) {
      // case !approvalRecord.workflow.enabled:
      //   return ctx.throw(400, ERROR_CODE_MAP['not_enable_workflow']);
      case approvalRecord.execution?.status:
        return ctx.throw(400, ERROR_CODE_MAP['execution_finished']);
      case approvalRecord.job?.status:
        return ctx.throw(400, ERROR_CODE_MAP['job_finished']);
      case approvalRecord.status !== APPROVAL_ACTION_STATUS.PENDING:
        return ctx.throw(400, ERROR_CODE_MAP['not_approval_pending']);
      case !needUpdateRecord && !(approvalRecord.node.config.actions ?? []).includes(status):
        return ctx.throw(400, ERROR_CODE_MAP['not_need_update']);
      default:
        break;
    }

    await approvalRecord.update({
      status: status,
      comment: data.comment,
      snapshot: approvalRecord.approval.data,
      summary: approvalRecord.approval.summary,
      collectionName: approvalRecord.approval.collectionName,
    });
    ctx.body = approvalRecord.get();
    ctx.status = 202;
    await next();
    approvalRecord.execution.workflow = approvalRecord.workflow;
    approvalRecord.job.execution = approvalRecord.execution;
    approvalRecord.job.latestUserJob = approvalRecord.get();
    const workflow = ctx.tego.pm.get(PluginWorkflow);
    const processor = workflow.createProcessor(approvalRecord.execution);
    processor.logger.info(
      `approval node (${approvalRecord.nodeId}) action trigger execution (${approvalRecord.execution.id}) to resume`,
    );
    workflow.resume(approvalRecord.job);
  },
};
