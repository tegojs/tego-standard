import { Plugin } from '@tego/server';

import WorkflowPlugin from '../..';
import SQLInstruction from './SQLInstruction';

/**
 * Registers the plugin sql plugin integration.
 */
export class PluginSql extends Plugin {
  async load() {
    const workflowPlugin = this.app.getPlugin<WorkflowPlugin>(WorkflowPlugin);
    workflowPlugin.registerInstruction('sql', SQLInstruction);

    // Register ACL snippet for SQL instruction access.
    // Covered by pm.* glob for root/admin roles.
    // The actual permission check is in actions/nodes.ts (assertSqlNodePermission).
    this.app.acl.registerSnippet({
      name: 'pm.workflow.sql',
      actions: ['sql_instructions:create', 'sql_instructions:update'],
    });
  }
}
