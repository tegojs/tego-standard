import { EXECUTION_STATUS, JOB_STATUS } from '@tachybase/plugin-workflow';
import { getApp } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import WorkflowPlugin from '../../..';
import { waitForFastAssertion as waitForAssertion, waitForWorkflowIdle } from '../../../__tests__/utils';
import ManualInstruction from '../../ManualInstruction';

describe('workflow > manual forms > tenant filter', () => {
  let app: MockServer;
  let agent;
  let userAgents;
  let db: Database;
  let plugin: WorkflowPlugin;
  let WorkflowModel;
  let UserModel;
  let users;
  let UserJobModel;

  const collectionName = 'tenant_manual_posts';
  const tenantAContext = {
    currentTenant: { id: 'tenant-a', name: 'tenant-a' },
    currentTenantId: 'tenant-a',
    currentTenantDescendantIds: [],
    currentTenancyMode: 'tenantScoped',
  };
  const tenantBContext = {
    currentTenant: { id: 'tenant-b', name: 'tenant-b' },
    currentTenantId: 'tenant-b',
    currentTenantDescendantIds: [],
    currentTenancyMode: 'tenantScoped',
  };

  beforeAll(async () => {
    app = await getApp({
      plugins: ['users', 'auth', 'workflow-manual'],
    });
    agent = app.agent();
    db = app.db;
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    WorkflowModel = db.getCollection('workflows').model;
    UserModel = db.getCollection('users').model;
    UserJobModel = db.getModel('users_jobs');

    users = await UserModel.bulkCreate([
      { id: 2, nickname: 'a' },
      { id: 3, nickname: 'b' },
    ]);

    userAgents = users.map((user) => app.agent().login(user));

    db.collection({
      name: collectionName,
      tenancy: 'tenantScoped',
      fields: [
        { type: 'string', name: 'title' },
        { type: 'string', name: 'tenantId' },
      ],
    });
    await db.sync();
  });

  beforeEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await UserJobModel.destroy({ where: {} });
    await db.getRepository('jobs').destroy({ filter: {} });
    await db.getRepository('executions').destroy({ filter: {} });
    await db.getRepository('workflows').destroy({ filter: {} });
    await db.getRepository(collectionName).destroy({ filter: {} });
  });

  afterEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
  });

  afterAll(() => app.destroy());

  async function createManualWorkflow(formConfig: Record<string, any>) {
    const workflow = await WorkflowModel.create({
      enabled: true,
      type: 'syncTrigger',
    });

    await workflow.createNode({
      type: 'manual',
      config: {
        assignees: [users[0].id],
        forms: {
          f1: formConfig,
        },
      },
    });

    return workflow;
  }

  async function triggerWithTenant(workflow, tenantContext) {
    await plugin.trigger(
      workflow,
      {
        data: {},
        state: tenantContext,
      },
      {
        context: {
          state: tenantContext,
        },
      },
    );

    const [execution] = await workflow.getExecutions();
    expect(execution.tenantId).toBe(tenantContext.currentTenantId);

    const jobs = await execution.getJobs();
    const pendingJob = jobs.find((j) => j.status === JOB_STATUS.PENDING);
    expect(pendingJob).toBeTruthy();

    const userJobs = await UserJobModel.findAll({
      where: { jobId: pendingJob.id },
    });
    expect(userJobs.length).toBe(1);

    return { execution, job: pendingJob, userJob: userJobs[0] };
  }

  it('manual create form should inject tenantId from execution context', async () => {
    const workflow = await createManualWorkflow({
      type: 'create',
      actions: [{ status: JOB_STATUS.RESOLVED, key: 'resolve' }],
      collection: collectionName,
    });

    const { userJob } = await triggerWithTenant(workflow, tenantAContext);

    const res = await userAgents[0].resource('users_jobs').submit({
      filterByTk: userJob.id,
      values: {
        result: { f1: { title: 'manual-create' }, _: 'resolve' },
      },
    });
    expect(res.status).toBe(202);

    await waitForAssertion(async () => {
      const posts = await db.getRepository(collectionName).find({ filter: { title: 'manual-create' } });
      expect(posts.length).toBe(1);
      expect(posts[0].tenantId).toBe('tenant-a');
    });
  });

  it('manual update form should scope to execution tenant', async () => {
    const TenantPostRepo = db.getRepository(collectionName);
    const postA = await TenantPostRepo.create({
      values: { title: 'target', tenantId: 'tenant-a' },
      hooks: false,
    });
    const postB = await TenantPostRepo.create({
      values: { title: 'target', tenantId: 'tenant-b' },
      hooks: false,
    });

    const workflow = await createManualWorkflow({
      type: 'update',
      actions: [{ status: JOB_STATUS.RESOLVED, key: 'resolve' }],
      collection: collectionName,
      filter: { title: 'target' },
    });

    const { userJob } = await triggerWithTenant(workflow, tenantAContext);

    const res = await userAgents[0].resource('users_jobs').submit({
      filterByTk: userJob.id,
      values: {
        result: { f1: { title: 'updated' }, _: 'resolve' },
      },
    });
    expect(res.status).toBe(202);

    await waitForAssertion(async () => {
      const [execution] = await workflow.getExecutions();
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    });

    await postA.reload();
    await postB.reload();
    expect(postA.title).toBe('updated');
    expect(postB.title).toBe('target');
  });

  it('manual create form should isolate records between A/B tenants', async () => {
    const TenantPostRepo = db.getRepository(collectionName);

    const workflowA = await createManualWorkflow({
      type: 'create',
      actions: [{ status: JOB_STATUS.RESOLVED, key: 'resolve' }],
      collection: collectionName,
    });

    const { userJob: userJobA } = await triggerWithTenant(workflowA, tenantAContext);

    const resA = await userAgents[0].resource('users_jobs').submit({
      filterByTk: userJobA.id,
      values: {
        result: { f1: { title: 'shared-title' }, _: 'resolve' },
      },
    });
    expect(resA.status).toBe(202);

    await waitForAssertion(async () => {
      const [execution] = await workflowA.getExecutions();
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
    });

    const workflowB = await WorkflowModel.create({
      enabled: true,
      type: 'syncTrigger',
    });
    await workflowB.createNode({
      type: 'manual',
      config: {
        assignees: [users[0].id],
        forms: {
          f1: {
            type: 'create',
            actions: [{ status: JOB_STATUS.RESOLVED, key: 'resolve' }],
            collection: collectionName,
          },
        },
      },
    });

    const { userJob: userJobB } = await triggerWithTenant(workflowB, tenantBContext);

    const resB = await userAgents[0].resource('users_jobs').submit({
      filterByTk: userJobB.id,
      values: {
        result: { f1: { title: 'shared-title' }, _: 'resolve' },
      },
    });
    expect(resB.status).toBe(202);

    await waitForAssertion(async () => {
      const allPosts = await TenantPostRepo.find({ filter: { title: 'shared-title' } });
      expect(allPosts.length).toBe(2);
      const tenantIds = allPosts.map((p) => p.tenantId).sort();
      expect(tenantIds).toEqual(['tenant-a', 'tenant-b']);
    });
  });
});
