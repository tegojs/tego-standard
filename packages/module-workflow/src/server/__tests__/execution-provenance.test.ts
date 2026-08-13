import path from 'node:path';
import { getApp } from '@tachybase/plugin-workflow-test';
import type { MockServer } from '@tachybase/test';

import { EVENT_SOURCE_EXECUTION_ORIGIN } from '../execution-provenance';
import { checkSqlExecutionPermission } from '../utils/sql-permission';

describe('workflow execution provenance', () => {
  let app: MockServer;
  let plugin: any;
  let WorkflowModel: any;

  beforeAll(async () => {
    app = await getApp({
      collectionsPath: path.resolve(__dirname, '../collections'),
    });
    plugin = app.pm.get('workflow') as any;
    plugin.ready = true;
    WorkflowModel = app.db.getCollection('workflows').model;
  });

  beforeEach(async () => {
    await app.db.getRepository('jobs').destroy({ filter: {} });
    await app.db.getRepository('executions').destroy({ filter: {} });
    await app.db.getRepository('workflows').destroy({ filter: {} });
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should persist provenance and restore it for recovery and child workflows', async () => {
    const workflow = await WorkflowModel.create({ enabled: true, type: 'syncTrigger' });
    const childWorkflow = await WorkflowModel.create({ enabled: true, type: 'syncTrigger' });
    const httpContext = {
      state: { currentRole: 'member' },
      app: { acl: { getRole: () => ({ effectiveSnippets: () => ({ allowed: [] }) }) } },
    };

    const processor = await plugin.triggerFromEventSource(workflow, {}, { httpContext });
    const persisted = await app.db.getRepository('executions').findOne({
      filterByTk: processor.execution.id,
    });

    expect(persisted.executionOrigin).toBe(EVENT_SOURCE_EXECUTION_ORIGIN);

    const recoveredProcessor = plugin.createProcessor(persisted, { httpContext });
    expect(() => checkSqlExecutionPermission(recoveredProcessor)).not.toThrow();

    const childProcessor = await plugin.trigger(childWorkflow, {}, recoveredProcessor.options);
    expect(childProcessor.execution.executionOrigin).toBe(EVENT_SOURCE_EXECUTION_ORIGIN);
  });

  it('should not trust forgeable string, boolean, or global symbol option values', async () => {
    const workflow = await WorkflowModel.create({ enabled: true, type: 'syncTrigger' });

    const processor = await plugin.trigger(
      workflow,
      {},
      {
        executionOrigin: EVENT_SOURCE_EXECUTION_ORIGIN,
        trustedWorkflowExecution: true,
        [Symbol.for('@tachybase/module-workflow/execution-origin')]: EVENT_SOURCE_EXECUTION_ORIGIN,
      },
    );

    expect(processor.execution.executionOrigin).toBeNull();
  });
});
