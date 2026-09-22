import { getApp } from '@tachybase/plugin-workflow-test';
import type { MockServer } from '@tachybase/test';

import PluginWorkflowApproval from '../plugin';

describe('workflow approval ACL', () => {
  let app: MockServer;

  beforeEach(async () => {
    app = await getApp({ plugins: [PluginWorkflowApproval, 'users', 'auth'] });
  });

  afterEach(async () => {
    await app?.destroy();
  });

  it.each([
    ['approvalRecords.approvalExecution', 'get'],
    ['approvalRecords.node', 'get'],
    ['approvalRecords.job', 'get'],
    ['approvalRecords.workflow', 'get'],
    ['approvalRecords.execution', 'get'],
    ['approvalRecords.user', 'get'],
    ['approvalRecords.approval', 'get'],
    ['approvalExecutions.execution', 'get'],
    ['approvalExecutions.approval', 'get'],
    ['approvals.workflow', 'get'],
    ['approvalCarbonCopy.workflow', 'get'],
    ['approvalCarbonCopy.node', 'get'],
    ['approvalCarbonCopy.job', 'get'],
    ['approvalCarbonCopy.execution', 'get'],
    ['approvalCarbonCopy.user', 'get'],
    ['approvalCarbonCopy.approval', 'get'],
    ['approvalCarbonCopy.createdBy', 'get'],
    ['approvals.approvalExecutions', 'list'],
    ['approvals.createdBy', 'get'],
    ['approvals.records', 'list'],
    ['workflows.nodes', 'list'],
    ['executions.jobs', 'list'],
  ])('allows logged-in users to read approval detail association %s:%s', async (resource, action) => {
    const allowed = await app.acl.allowManager.isAllowed(resource, action, {
      state: { currentUser: { id: 8 } },
    });

    expect(allowed).toBe(true);
  });

  it.each([
    ['workflows', 'get'],
    ['executions', 'get'],
    ['jobs', 'get'],
  ])('does not expose the root resource %s:%s through approval detail permissions', async (resource, action) => {
    const allowed = await app.acl.allowManager.isAllowed(resource, action, {
      state: { currentUser: { id: 8 } },
    });

    expect(allowed).toBe(false);
  });
});
