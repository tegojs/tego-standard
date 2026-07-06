import { actions, Context, Next, Op, utils } from '@tego/server';

import { EXECUTION_STATUS, JOB_STATUS } from '../constants';
import {
  buildWorkflowExecutionTenantFilter,
  canReadLegacyExecutions,
  getCurrentTenantIdFromState,
  NEVER_MATCH_TENANT_FILTER,
} from '../helpers/tenant-context';
import Plugin from '../Plugin';
import { triggerWorkflowAndGetExecution } from '../utils';

function getModelValue(model: any, key: string) {
  return model?.get?.(key) ?? model?.[key];
}

function isTenantPluginEnabled(ctx: Context) {
  const pluginManagers = [ctx.tego?.pm, ctx.app?.pm];

  for (const pluginManager of pluginManagers) {
    try {
      const tenantPlugin = pluginManager?.get?.('tenant');
      if (tenantPlugin?.enabled === true) {
        return true;
      }
    } catch {
      // Ignore plugin-manager lookup failures and fall back to state checks.
    }
  }

  return false;
}

export function shouldApplyExecutionTenantBoundary(ctx: Context) {
  const state = ctx.state || {};
  const tenantId = getCurrentTenantIdFromState(state);
  return (
    (tenantId !== null && tenantId !== undefined) || Boolean(state.currentTenancyMode) || isTenantPluginEnabled(ctx)
  );
}

export function buildExecutionTenantFilter(ctx: Context, fallback: any = NEVER_MATCH_TENANT_FILTER) {
  return buildWorkflowExecutionTenantFilter(ctx.state, shouldApplyExecutionTenantBoundary(ctx) ? fallback : null);
}

function appendExecutionTenantFilter(filter: any, ctx: Context, fallback: any = NEVER_MATCH_TENANT_FILTER) {
  const tenantFilter = buildExecutionTenantFilter(ctx, fallback);
  if (!tenantFilter) {
    return filter;
  }

  return {
    $and: [filter, tenantFilter],
  };
}

function assertExecutionInCurrentTenant(ctx: Context, execution: any) {
  const tenantId = getCurrentTenantIdFromState(ctx.state);
  if (tenantId === null || tenantId === undefined || !execution) {
    return;
  }

  const executionTenantId = getModelValue(execution, 'tenantId');
  if ((executionTenantId === null || executionTenantId === undefined) && canReadLegacyExecutions(ctx.state, tenantId)) {
    return;
  }

  if (`${executionTenantId}` !== `${tenantId}`) {
    ctx.throw(404, ctx.t('No execution records found for this workflow.', { ns: 'workflow' }));
  }
}

export async function destroy(ctx: Context, next) {
  ctx.action.mergeParams({
    filter: appendExecutionTenantFilter(
      {
        status: {
          [Op.ne]: EXECUTION_STATUS.STARTED,
        },
      },
      ctx,
    ),
  });

  await actions.destroy(ctx, next);
}

export async function cancel(ctx: Context, next) {
  const { filterByTk } = ctx.action.params;
  const ExecutionRepo = ctx.db.getRepository('executions');
  const JobRepo = ctx.db.getRepository('jobs');
  const execution = await ExecutionRepo.findOne({
    filterByTk,
    filter: buildExecutionTenantFilter(ctx),
    appends: ['jobs'],
  });
  if (!execution) {
    return ctx.throw(404);
  }
  assertExecutionInCurrentTenant(ctx, execution);
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
    filter: buildExecutionTenantFilter(ctx),
  });
  if (!execution) {
    ctx.throw(404, ctx.t('No execution records found for this workflow.', { ns: 'workflow' }));
  }
  assertExecutionInCurrentTenant(ctx, execution);
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
