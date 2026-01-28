import PluginErrorHandler from '@tachybase/module-error-handler';
import { joinCollectionName, type Context, type Next } from '@tego/server';

import { EXECUTION_STATUS } from '../../constants';
import PluginWorkflowServer from '../../Plugin';
import Trigger from '../../triggers';

class RequestInterceptionError extends Error {
  status = 400;
  messages = [];
  constructor(message) {
    super(message);
    this.name = 'RequestInterceptionError';
  }
}

export class RequestInterceptionTrigger extends Trigger {
  static TYPE = 'request-interception';
  sync = true;
  middleware = async (ctx: Context, next: Next) => {
    const {
      resourceName,
      actionName,
      params: { filterByTk, filter, values, triggerWorkflows = '' },
    } = ctx.action;
    const dataSourceHeader = ctx.get('x-data-source');
    const jointCollectionName = joinCollectionName(dataSourceHeader, resourceName);
    const triggerWorkflowsMap = new Map();
    const triggerWorkflowsArray = [];
    for (const trigger of triggerWorkflows.split(',')) {
      const [key, path] = trigger.split('!');
      triggerWorkflowsMap.set(key, path);
      triggerWorkflowsArray.push(key);
    }
    const workflows = Array.from(this.workflow.enabledCache.values()).filter(
      (item) => item.type === RequestInterceptionTrigger.TYPE && item.config.collection === jointCollectionName,
    );
    const globalWorkflows = workflows
      .filter((item) => {
        return item.config.global && item.config.actions?.includes(actionName);
      })
      .sort((a, b) => a.id - b.id);
    const localWorkflows = workflows
      .filter((item) => !item.config.global)
      .sort((a, b) => {
        const aIndex = triggerWorkflowsArray.indexOf(a.key);
        const bIndex = triggerWorkflowsArray.indexOf(b.key);
        if (aIndex === -1 && bIndex === -1) {
          return a.id - b.id;
        }
        if (aIndex === -1) {
          return 1;
        }
        if (bIndex === -1) {
          return -1;
        }
        return aIndex - bIndex;
      });
    for (const workflow of localWorkflows.concat(globalWorkflows)) {
      if (!workflow.config.global && !triggerWorkflowsMap.has(workflow.key)) {
        continue;
      }
      const processor = await this.workflow.trigger(
        workflow,
        {
          user: ctx.state.currentUser,
          roleName: ctx.state.currentRole,
          params: {
            filterByTk,
            filter,
            values,
          },
        },
        { httpContext: ctx },
      );
      if (!processor) {
        return ctx.throw(500);
      }
      const { lastSavedJob, nodesMap } = processor;
      const lastNode = nodesMap.get(lastSavedJob?.nodeId);
      if (processor.execution.status === EXECUTION_STATUS.RESOLVED) {
        if (lastNode?.type === 'end') {
          return;
        }
        continue;
      }
      if (processor.execution.status < EXECUTION_STATUS.STARTED) {
        if (lastNode?.type !== 'end') {
          return ctx.throw(
            500,
            ctx.t('Workflow on your action failed, please contact the administrator', { ns: 'workflow' }),
          );
        }
        const err = new RequestInterceptionError('Request is intercepted by workflow');
        err.status = 400;
        err.messages = ctx.state.messages;
        return ctx.throw(err.status, err);
      }
      return ctx.throw(500, 'Workflow on your action hangs, please contact the administrator');
    }
    await next();
  };
  constructor(workflow: PluginWorkflowServer) {
    super(workflow);
    workflow.app.use(this.middleware, { tag: 'workflowFilter', after: 'dataSource' });
    (workflow.app.pm.get(PluginErrorHandler) as InstanceType<typeof PluginErrorHandler>).errorHandler.register(
      (err) => err instanceof RequestInterceptionError,
      async (err, ctx) => {
        ctx.body = {
          errors: err.messages,
        };
        ctx.status = err.status;
      },
    );
  }
  on() {}
  off() {}
}
