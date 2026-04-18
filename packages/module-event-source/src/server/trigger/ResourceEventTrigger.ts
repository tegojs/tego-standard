import { JOB_STATUS } from '@tachybase/module-workflow';
import { Context } from '@tego/server';

import { EventSourceModel } from '../model/EventSourceModel';
import { EventSourceQueueWorker } from '../queue/EventSourceQueueWorker';
import { WebhookController } from '../webhooks/webhooks';
import { EventSourceTrigger } from './Trigger';

export class ResourceEventTrigger extends EventSourceTrigger {
  // 优先级越小越靠前
  private beforeList: EventSourceModel[] = [];
  private afterList: EventSourceModel[] = [];

  load(model: EventSourceModel) {
    if (!model.options) {
      return;
    }
    const { type } = model;
    const prefix = type.substring(0, type.indexOf('Resource'));
    if (prefix === 'before') {
      this.beforeList.push(model.toJSON());
    } else {
      this.afterList.push(model.toJSON());
    }
  }

  afterAllLoad() {
    this.app.resourcer.use(
      async (ctx: Context, next: () => Promise<void>) => {
        const { resourceName, actionName } = ctx.action;
        if (!this.beforeList.length && !this.afterList.length) {
          return next();
        }
        const matchBefore = this.getMatchList(this.beforeList, resourceName, actionName);
        const matchAfter = this.getMatchList(this.afterList, resourceName, actionName);
        if (!matchBefore.length && !matchAfter.length) {
          return next();
        }
        for (const model of matchBefore) {
          await this.executeByPolicy(ctx, model, 'beforeResource');
        }
        await next();
        for (const model of matchAfter) {
          await this.executeByPolicy(ctx, model, 'afterResource');
        }
      },
      { tag: 'event-source-resource' },
    );
  }

  /**
   * failurePolicy 未设置：与 main 分支一致（遗留行为）
   * - beforeResource：工作流 ERROR 时阻断（原 400）
   * - afterResource：不因工作流 ERROR 状态阻断（原逻辑未校验）
   * 显式 ignore：失败不阻断主请求
   * 显式 block：任意失败均阻断
   */
  private getFailurePolicy(model: EventSourceModel): 'ignore' | 'block' | 'legacy' {
    const fp = model?.options?.failurePolicy;
    if (fp === 'ignore') {
      return 'ignore';
    }
    if (fp === 'block') {
      return 'block';
    }
    return 'legacy';
  }
  private getExecutionMode(model: EventSourceModel): 'inline' | 'queue' {
    return model?.options?.executionMode === 'queue' ? 'queue' : 'inline';
  }
  private getMaxAttempts(model: EventSourceModel): number {
    const value = Number(model?.options?.maxAttempts || 3);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3;
  }
  private getRetryBackoffMs(model: EventSourceModel): number {
    const value = Number(model?.options?.retryBackoffMs || 3000);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3000;
  }

  private getTimeoutMs(model: EventSourceModel): number {
    const timeoutMs = Number(model?.options?.timeoutMs || 0);
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

  private async executeByPolicy(ctx: Context, model: EventSourceModel, stage: 'beforeResource' | 'afterResource') {
    const failurePolicy = this.getFailurePolicy(model);
    const executionMode = this.getExecutionMode(model);
    const timeoutMs = this.getTimeoutMs(model);
    try {
      if (executionMode === 'queue') {
        const body = await new WebhookController().action(ctx, model);
        const queueWorker = (this.app as any).eventSourceQueueWorker as EventSourceQueueWorker;
        if (!queueWorker) {
          throw new Error('eventSourceQueueWorker is not available');
        }
        await queueWorker.enqueue({
          sourceId: model.id,
          stage,
          resourceName: model?.options?.resourceName,
          actionName: model?.options?.actionName,
          workflowKey: model.workflowKey,
          payload: body,
          contextLite: {
            userId: ctx?.state?.currentUser?.id,
            roleName: ctx?.state?.currentRole,
          },
          maxAttempts: this.getMaxAttempts(model),
          retryBackoffMs: this.getRetryBackoffMs(model),
        });
        return;
      }
      const result = await this.withTimeout(
        async () => {
          const body = await new WebhookController().action(ctx, model);
          return await new WebhookController().triggerWorkflow(ctx, model, body);
        },
        timeoutMs,
        `[event-source] ${stage} timeout, sourceId=${model.id}, timeoutMs=${timeoutMs}`,
      );
      if (result && result.lastSavedJob.status === JOB_STATUS.ERROR) {
        if (failurePolicy === 'ignore') {
          return;
        }
        if (failurePolicy === 'block') {
          throw new Error(`${result.lastSavedJob.result}`);
        }
        // legacy：仅 beforeResource 与工作流 main 一致，返回 400
        if (stage === 'beforeResource') {
          ctx.throw(400, result.lastSavedJob.result);
        }
        return;
      }
    } catch (error) {
      this.app.logger.error(
        `[event-source] ${stage} execution failed. policy=${failurePolicy}, sourceId=${model.id}, workflowKey=${model.workflowKey}, error=${error?.stack || error}`,
      );
      if (failurePolicy === 'ignore') {
        return;
      }
      if (failurePolicy === 'block') {
        throw error;
      }
      // legacy：异常始终向上抛出（与 main 无 try/catch 时一致）
      throw error;
    }
  }

  private getMatchList(list: EventSourceModel[], resourceName: string, actionName: string): EventSourceModel[] {
    const matchList = [];
    // 优先按照options.sort 从小到大排序，再按照id从小到大排序
    list.sort((a, b) => {
      let diffSort = a.options.sort - b.options.sort;
      if (diffSort !== 0) {
        return diffSort;
      }
      return a.id - b.id;
    });
    for (const item of list) {
      let targetResource = resourceName || '';
      if (item.options.triggerOnAssociation) {
        const parts = resourceName.split('.');
        if (parts.length === 2) {
          const collection = this.app.db.getCollection(resourceName);
          targetResource = collection?.name;
        }
      }
      if (item.options.resourceName === targetResource && item.options.actionName === actionName) {
        matchList.push(item);
      }
    }
    return matchList;
  }

  afterCreate(model: EventSourceModel) {
    const { type } = model;
    const prefix = type.substring(0, type.indexOf('Resource'));
    if (prefix === 'before') {
      this.beforeList.push(model);
    } else {
      this.afterList.push(model);
    }
  }

  afterUpdate(model: EventSourceModel) {
    const { type } = model;
    const prefix = type.substring(0, type.indexOf('Resource'));
    if (prefix === 'before') {
      this.afterUpdateList(this.beforeList, model);
    } else {
      this.afterUpdateList(this.afterList, model);
    }
  }
  private afterUpdateList(list: EventSourceModel[], model: EventSourceModel) {
    const index = list.findIndex((item) => item.id === model.id);
    if (!model.enabled) {
      if (index !== -1) {
        list.splice(index, 1);
      }
      return;
    }
    if (index !== -1) {
      list[index] = model.toJSON();
    } else {
      list.push(model.toJSON());
    }
  }

  afterDestroy(model: EventSourceModel) {
    const { type } = model;
    const prefix = type.substring(0, type.indexOf('Resource'));
    if (prefix === 'before') {
      this.afterDestroyList(this.beforeList, model);
    } else {
      this.afterDestroyList(this.afterList, model);
    }
  }
  private afterDestroyList(list: EventSourceModel[], model: EventSourceModel) {
    const index = list.findIndex((item) => item.id === model.id);
    if (index !== -1) {
      list.splice(index, 1);
    }
  }
}
