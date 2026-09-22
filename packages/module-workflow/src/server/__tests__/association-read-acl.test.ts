import { getApp } from '@tachybase/plugin-workflow-test';
import type { MockServer } from '@tachybase/test';

describe('workflow detail association ACL', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await getApp();
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it.each([
    ['workflowNotice.workflow', 'get'],
    ['workflowNotice.node', 'get'],
    ['workflowNotice.job', 'get'],
    ['workflowNotice.execution', 'get'],
    ['workflowNotice.user', 'get'],
    ['users_jobs.workflow', 'get'],
    ['users_jobs.node', 'get'],
    ['users_jobs.job', 'get'],
    ['users_jobs.execution', 'get'],
    ['users_jobs.user', 'get'],
    ['workflows.nodes', 'list'],
    ['executions.jobs', 'list'],
  ])('allows logged-in users to read %s:%s', async (resource, action) => {
    const allowed = await app.acl.allowManager.isAllowed(resource, action, {
      state: { currentUser: { id: 8 } },
    });

    expect(allowed).toBe(true);
  });
});
