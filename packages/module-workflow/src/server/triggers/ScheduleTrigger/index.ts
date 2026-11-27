import { parseCollectionName } from '@tego/server';

import { Transactionable } from 'sequelize';

import Trigger from '..';
import type Plugin from '../../Plugin';
import { WorkflowModel } from '../../types';
import DateFieldScheduleTrigger from './DateFieldScheduleTrigger';
import StaticScheduleTrigger from './StaticScheduleTrigger';
import { SCHEDULE_MODE } from './utils';

export default class ScheduleTrigger extends Trigger {
  sync = false;

  private modes = new Map();

  constructor(workflow: Plugin) {
    super(workflow);

    this.modes.set(SCHEDULE_MODE.STATIC, new StaticScheduleTrigger(workflow));
    this.modes.set(SCHEDULE_MODE.DATE_FIELD, new DateFieldScheduleTrigger(workflow));
  }

  private getTrigger(mode: number) {
    return this.modes.get(mode);
  }

  on(workflow) {
    const mode = workflow.config.mode;
    const trigger = this.getTrigger(mode);
    if (trigger) {
      trigger.on(workflow);
    }
  }

  off(workflow) {
    const mode = workflow.config.mode;
    const trigger = this.getTrigger(mode);
    if (trigger) {
      trigger.off(workflow);
    }
  }

  async validateEvent(workflow: WorkflowModel, context: any, options: Transactionable): Promise<boolean> {
    if (!context.date) {
      return false;
    }
    const conditions: Record<string, unknown> = { 'context.date': context.date };
    if (workflow.config.mode === SCHEDULE_MODE.DATE_FIELD) {
      const [dataSourceName, collectionName] = parseCollectionName(workflow.config.collection);
      const collection = this.workflow.app.dataSourceManager.dataSources
        .get(dataSourceName)
        ?.collectionManager.getCollection(collectionName);
      const key = collection?.filterTargetKey;
      if (typeof key !== 'string' || context.data?.[key] === null || context.data?.[key] === undefined) {
        return false;
      }
      // Visibility in another tenant must not duplicate a record, or suppress a different one.
      conditions[`context.data.${key}`] = context.data[key];
    }
    const existed = await workflow.countExecutions({
      where: conditions,
      transaction: options.transaction,
    });
    return !existed;
  }
}
