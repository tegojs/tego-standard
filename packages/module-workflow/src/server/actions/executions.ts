import { actions, Context, Next, Op, utils } from '@tego/server';

import { EXECUTION_STATUS, JOB_STATUS } from '../constants';
import Plugin from '../Plugin';
import { triggerWorkflowAndGetExecution } from '../utils';

export async function destroy(ctx: Context, next) {
  ctx.action.mergeParams({
    filter: {
      status: {
        [Op.ne]: EXECUTION_STATUS.STARTED,
      },
    },
  });

  await actions.destroy(ctx, next);
}

export async function cancel(ctx: Context, next) {
  const { filterByTk } = ctx.action.params;
  const ExecutionRepo = ctx.db.getRepository('executions');
  const JobRepo = ctx.db.getRepository('jobs');
  const execution = await ExecutionRepo.findOne({
    filterByTk,
    appends: ['jobs'],
  });
  if (!execution) {
    return ctx.throw(404);
  }
  if (execution.status) {
    return ctx.throw(400);
  }
  const cancelAt = new Date();
  const executionDuration = cancelAt.getTime() - execution.createdAt.getTime();
  await ctx.db.sequelize.transaction(async (transaction) => {
    await execution.update(
      {
        executionCost: executionDuration,
        updatedAt: cancelAt,
        status: EXECUTION_STATUS.CANCELED,
      },
      { transaction },
    );

    const pendingJobs = execution.jobs.filter((job) => job.status === JOB_STATUS.PENDING);
    await JobRepo.update({
      values: {
        status: JOB_STATUS.CANCELED,
      },
      filter: {
        id: pendingJobs.map((job) => job.id),
      },
      individualHooks: false,
      transaction,
    });
  });

  ctx.body = execution;
  await next();
}

export async function retry(ctx: Context, next: Next) {
  const plugin = ctx.tego.pm.get(Plugin);
  const repository = utils.getRepositoryFromParams(ctx);
  const { filterByTk, filter = {}, values = {} } = ctx.action.params;
  const WorkflowRepo = ctx.db.getRepository('workflows');

  if (!ctx.state) {
    ctx.state = {};
  }
  if (!ctx.state.messages) {
    ctx.state.messages = [];
  }
  if (!filterByTk) {
    ctx.throw(400, ctx.t('Execution ID is required', { ns: 'workflow' }));
  }
  const execution = await repository.findOne({
    filterByTk,
  });
  if (!execution) {
    ctx.throw(404, ctx.t('No execution records found for this workflow.', { ns: 'workflow' }));
  }
  const workflow = await WorkflowRepo.findOne({
    filterByTk: execution.workflowId,
    appends: ['nodes'],
    context: ctx,
  });
  if (!workflow) {
    ctx.throw(404, ctx.t('Associated workflow not found.', { ns: 'workflow' }));
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
      return ctx.throw(500, ctx.t('Failed to create execution', { ns: 'workflow' }));
    }

    ctx.state.messages.push({ message: ctx.t('Execute ended', { ns: 'workflow' }) });
    ctx.body = newExecution;
  } catch (error) {
    ctx.tego.logger.error(`Failed to retry execution ${execution.id}: ${error.message}`);
    ctx.throw(500, ctx.t('Failed to retry execution', { ns: 'workflow' }));
  }

  await next();
}
