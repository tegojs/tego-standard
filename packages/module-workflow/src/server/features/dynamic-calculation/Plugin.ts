import { Plugin } from '@tego/server';

import WorkflowPlugin from '../..';
import { DynamicCalculation } from './DynamicCalculation';
import { ExpressionField } from './expression-field';

export class PluginDynamicCalculation extends Plugin {
  async load() {
    this.db.registerFieldTypes({
      expression: ExpressionField,
    });

    const workflowPlugin = this.app.getPlugin<WorkflowPlugin>(WorkflowPlugin);
    workflowPlugin.registerInstruction('dynamic-calculation', DynamicCalculation);
  }
}
