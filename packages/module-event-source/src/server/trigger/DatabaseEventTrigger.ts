import { JOB_STATUS, PluginWorkflow, Processor } from '@tachybase/module-workflow';

import { EventSourceModel } from '../model/EventSourceModel';
import { evalSimulate } from '../utils/eval-simulate';
import { EventSourceTrigger } from './Trigger';

export class DatabaseEventTrigger extends EventSourceTrigger {
  eventMap: Map<number, (...args: any[]) => void> = new Map();

  load(model: EventSourceModel) {
    if (!model.options) {
      return;
    }
    const {
      options: { eventName },
      workflowKey,
      code,
    } = model;
    this.app.logger.info('Add database event listener', { meta: { eventName, workflowKey } });
    const callback = this.getDbEvent(model).bind(this);
    this.app.db.on(eventName, callback);
    this.eventMap.set(model.id, callback);
  }

  getDbEvent(model: EventSourceModel) {
    const { code, workflowKey } = model;
    return async (model, options) => {
      const webhookCtx = {
        body: '',
        model,
        options,
      };
      try {
        await evalSimulate(code, {
          ctx: webhookCtx,
          lib: {
            JSON,
            Math,
          },
        });
      } catch (err) {
        this.app.logger.error(err);
      }
      // 只有绑定工作流才执行
      if (!workflowKey) {
        return;
      }
      // TODO: 执行人设置为创建这个任务的人/或者更新这个任务的人
      const pluginWorkflow = this.app.getPlugin(PluginWorkflow) as PluginWorkflow;
      const wfRepo = this.app.db.getRepository('workflows');
      const wf = await wfRepo.findOne({ filter: { key: workflowKey, enabled: true } });
      const result = (await pluginWorkflow.trigger(
        wf,
        { data: webhookCtx.body },
        { dbModel: model, dbOptions: options, ...options },
      )) as Processor;
      if (result?.lastSavedJob.status === JOB_STATUS.ERROR) {
        const errorResult = result.lastSavedJob?.result;
        // 安全地处理错误结果，避免解构赋值问题
        let errorMessage = 'Workflow execution failed';

        if (typeof errorResult === 'string') {
          errorMessage = errorResult;
        } else if (errorResult && typeof errorResult === 'object') {
          if (errorResult.message) {
            errorMessage = errorResult.message;
            if (errorResult.stack) {
              errorMessage += '\nStack: ' + errorResult.stack;
            }
          } else {
            // 避免直接使用 JSON.stringify，可能包含循环引用
            try {
              errorMessage = JSON.stringify(errorResult, null, 2);
            } catch (e) {
              errorMessage = `Workflow error: ${Object.prototype.toString.call(errorResult)}`;
            }
          }
        }

        throw new Error(errorMessage);
      }
    };
  }

  afterCreate(model: EventSourceModel) {
    this.load(model);
  }

  afterUpdate(model: EventSourceModel) {
    if (model.enabled && !this.workSet.has(model.id)) {
      this.load(model);
    } else if (!model.enabled && this.workSet.has(model.id)) {
      this.app.db.off(model.options.eventName, this.eventMap.get(model.id));
      this.eventMap.delete(model.id);
    } else if (this.changeWithOutType(model)) {
      const { eventName: oldEventName } = this.effectConfigMap.get(model.id).options ?? {};
      this.app.db.off(oldEventName, this.eventMap.get(model.id));
      this.eventMap.delete(model.id);
      this.load(model);
    }
  }

  afterDestroy(model: EventSourceModel) {
    const callback = this.eventMap.get(model.id);
    if (!callback) {
      return;
    }
    this.app.db.off(model.options.eventName, callback);
    this.eventMap.delete(model.id);
  }
}
