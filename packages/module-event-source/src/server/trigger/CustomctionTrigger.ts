import { Processor } from '@tachybase/module-workflow';
import { Context } from '@tego/server';

import { EventSourceModel } from '../model/EventSourceModel';
import { EventSourceQueueWorker } from '../queue/EventSourceQueueWorker';
import { WebhookController } from '../webhooks/webhooks';
import { EventSourceTrigger } from './Trigger';

type IAPITriggerConfig = {
  code: string;
  workflowKey: string;
  options?: EventSourceModel['options'];
};
export class CustomActionTrigger extends EventSourceTrigger {
  eventMap: Map<number, IAPITriggerConfig> = new Map();

  /** 未设置 failurePolicy 时与 main 一致：工作流失败则 500 */
  private getFailurePolicy(config: IAPITriggerConfig): 'ignore' | 'block' {
    return config?.options?.failurePolicy === 'ignore' ? 'ignore' : 'block';
  }
  private getExecutionMode(config: IAPITriggerConfig): 'inline' | 'queue' {
    return config?.options?.executionMode === 'queue' ? 'queue' : 'inline';
  }
  private getMaxAttempts(config: IAPITriggerConfig): number {
    const value = Number(config?.options?.maxAttempts || 3);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3;
  }
  private getRetryBackoffMs(config: IAPITriggerConfig): number {
    const value = Number(config?.options?.retryBackoffMs || 3000);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3000;
  }

  private getTimeoutMs(config: IAPITriggerConfig): number {
    const timeoutMs = Number(config?.options?.timeoutMs || 0);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return 0;
    }
    return timeoutMs;
  }

  private async withTimeout<T>(executor: () => Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    if (!timeoutMs) {
      return executor();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    try {
      return await Promise.race([executor(), timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  load(model: EventSourceModel) {
    if (!model.options) {
      return;
    }
    const app = this.app;
    const {
      options: { actionName, resourceName },
      id,
      code,
      workflowKey,
    } = model;
    this.eventMap.set(id, { code, workflowKey, options: model.options });
    if (!app.resourcer.isDefined(resourceName)) {
      app.resourcer.define({ name: resourceName });
    }
    if (app.resourcer.getResource(resourceName).actions.has(actionName)) {
      app.logger.warn(`${resourceName}:${actionName} action handler exists`);
      // pass when exists
      return;
    }
    app.logger.info(`Add ${resourceName}:${actionName} action handler`);
    app.resourcer.getResource(resourceName).addAction(actionName, async (ctx: Context) => {
      // 如果允许实时刷新,则间接禁用这个接口
      if (this.realTimeRefresh && !this.workSet.has(id)) {
        ctx.throw(404, 'Not found');
      }
      const config = this.eventMap.get(id);
      if (!config) {
        ctx.throw(404, 'Not found');
        return;
      }
      const failurePolicy = this.getFailurePolicy(config);
      const executionMode = this.getExecutionMode(config);
      const timeoutMs = this.getTimeoutMs(config);
      try {
        if (executionMode === 'queue') {
          const body = await new WebhookController().action(ctx, { code: config.code });
          const queueWorker = (this.app as any).eventSourceQueueWorker as EventSourceQueueWorker;
          if (!queueWorker) {
            throw new Error('eventSourceQueueWorker is not available');
          }
          await queueWorker.enqueue({
            sourceId: id,
            stage: 'customAction',
            resourceName: ctx?.action?.resourceName,
            actionName: ctx?.action?.actionName,
            workflowKey: config.workflowKey,
            payload: body,
            contextLite: {
              userId: ctx?.state?.currentUser?.id,
              roleName: ctx?.state?.currentRole,
            },
            maxAttempts: this.getMaxAttempts(config),
            retryBackoffMs: this.getRetryBackoffMs(config),
          });
          ctx.withoutDataWrapping = true;
          ctx.body = { queued: true };
          return;
        }
        const res = await this.withTimeout(
          async () => {
            const body = await new WebhookController().action(ctx, { code: config.code });
            return await new WebhookController().triggerWorkflow(ctx, config, body);
          },
          timeoutMs,
          `[event-source] custom action timeout, sourceId=${id}, timeoutMs=${timeoutMs}`,
        );
        const lastSavedJob = (<Processor>res)?.lastSavedJob;
        if (lastSavedJob?.get('status') < 0) {
          throw new Error(`${lastSavedJob.get('result')}`);
        }
      } catch (error) {
        app.logger.error(
          `[event-source] custom action execution failed. policy=${failurePolicy}, sourceId=${id}, workflowKey=${config?.workflowKey}, error=${error?.stack || error}`,
        );
        if (failurePolicy === 'block') {
          ctx.throw(500, error?.message || 'Custom action execution failed');
        }
      }
    });
    app.acl.allow(resourceName, actionName, 'loggedIn');
  }

  afterCreate(model: EventSourceModel) {
    this.load(model);
  }

  // TODO 很难修改和删除,目前实时刷新的时候间接修改
  afterUpdate(model: EventSourceModel) {
    const { enabled, code, workflowKey, id, options } = model;
    if (enabled && !this.workSet.has(id)) {
      this.load(model);
    } else {
      this.eventMap.set(id, { code, workflowKey, options });
    }
  }
}
