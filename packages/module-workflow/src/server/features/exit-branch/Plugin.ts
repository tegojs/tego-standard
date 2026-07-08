import { Plugin } from '@tego/server';

import PluginWorkflowServer from '../../Plugin';
import { ExitBranchInstruction } from './ExitBranchInstruction';

export class PluginExitBranch extends Plugin {
  async load() {
    const workflowPlugin = this.app.pm.get(PluginWorkflowServer) as PluginWorkflowServer;
    workflowPlugin.registerInstruction('exit-branch', ExitBranchInstruction);
  }
}
