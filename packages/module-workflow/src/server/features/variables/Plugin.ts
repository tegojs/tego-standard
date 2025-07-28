import { Plugin } from '@tego/server';

import PluginWorkflowServer from '../../Plugin';
import { VariablesInstruction } from './VariableInstruction';

export class PluginVariables extends Plugin {
  async load() {
    const workflowPlugin = this.app.getPlugin<PluginWorkflowServer>(PluginWorkflowServer);
    workflowPlugin.registerInstruction('variable', VariablesInstruction);
  }
}
