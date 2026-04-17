import { JOB_STATUS } from '@tachybase/module-workflow';
import { Context } from '@tego/server';

import { EventSourceModel } from '../model/EventSourceModel';
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

  private getFailurePolicy(model: EventSourceModel): 'ignore' | 'block' {
    return model?.options?.failurePolicy === 'block' ? 'block' : 'ignore';
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
    const timeoutMs = this.getTimeoutMs(model);
    try {
      const result = await this.withTimeout(
        async () => {
          const body = await new WebhookController().action(ctx, model);
          return await new WebhookController().triggerWorkflow(ctx, model, body);
        },
        timeoutMs,
        `[event-source] ${stage} timeout, sourceId=${model.id}, timeoutMs=${timeoutMs}`,
      );
      if (result && result.lastSavedJob.status === JOB_STATUS.ERROR) {
        throw new Error(`${result.lastSavedJob.result}`);
      }
    } catch (error) {
      this.app.logger.error(
        `[event-source] ${stage} execution failed. policy=${failurePolicy}, sourceId=${model.id}, workflowKey=${model.workflowKey}, error=${error?.stack || error}`,
      );
      if (failurePolicy === 'block') {
        throw error;
      }
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
