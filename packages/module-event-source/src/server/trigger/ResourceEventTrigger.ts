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
          try {
            const body = await new WebhookController().action(ctx, model);
            const result = await new WebhookController().triggerWorkflow(ctx, model, body);
            // Keep event sources isolated: workflow failures should not block primary request.
            if (result && result.lastSavedJob.status === JOB_STATUS.ERROR) {
              this.app.logger.error(
                `[event-source] beforeResource workflow failed, ignored. sourceId=${model.id}, workflowKey=${model.workflowKey}, result=${result.lastSavedJob.result}`,
              );
            }
          } catch (error) {
            this.app.logger.error(
              `[event-source] beforeResource execution failed, ignored. sourceId=${model.id}, workflowKey=${model.workflowKey}, error=${error?.stack || error}`,
            );
          }
        }
        await next();
        for (const model of matchAfter) {
          try {
            const body = await new WebhookController().action(ctx, model);
            const result = await new WebhookController().triggerWorkflow(ctx, model, body);
            if (result && result.lastSavedJob.status === JOB_STATUS.ERROR) {
              this.app.logger.error(
                `[event-source] afterResource workflow failed, ignored. sourceId=${model.id}, workflowKey=${model.workflowKey}, result=${result.lastSavedJob.result}`,
              );
            }
          } catch (error) {
            this.app.logger.error(
              `[event-source] afterResource execution failed, ignored. sourceId=${model.id}, workflowKey=${model.workflowKey}, error=${error?.stack || error}`,
            );
          }
        }
      },
      { tag: 'event-source-resource' },
    );
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
