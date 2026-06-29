import { getApp } from '@tachybase/plugin-workflow-test';
import Database, { Application } from '@tego/server';

import WorkflowPlugin from '../..';

describe('workflow > instructions > tenant filter', () => {
  let app: Application;
  let db: Database;
  let plugin: WorkflowPlugin;
  let WorkflowModel;
  let TenantPostRepo;

  const collectionName = 'tenant_workflow_posts';
  const tenantContext = {
    currentTenant: { id: 'tenant-a', name: 'tenant-a' },
    currentTenantId: 'tenant-a',
    currentTenantDescendantIds: [],
    currentTenancyMode: 'tenantScoped',
  };

  beforeEach(async () => {
    app = await getApp();
    db = app.db;
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    WorkflowModel = db.getCollection('workflows').model;

    db.collection({
      name: collectionName,
      tenancy: 'tenantScoped',
      fields: [
        { type: 'string', name: 'title' },
        { type: 'string', name: 'tenantId' },
        { type: 'boolean', name: 'published', defaultValue: false },
      ],
    });
    await db.sync();

    TenantPostRepo = db.getRepository(collectionName);
  });

  afterEach(() => app.destroy());

  async function createWorkflowWithNode(type: string, config: Record<string, any>) {
    const workflow = await WorkflowModel.create({
      enabled: true,
      type: 'syncTrigger',
    });

    await workflow.createNode({
      type,
      config: {
        collection: collectionName,
        ...config,
      },
    });

    return workflow;
  }

  async function triggerWorkflow(workflow) {
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
    const [job] = await execution.getJobs();
    return job;
  }

  async function createSameTitleTenantPosts() {
    const tenantBPost = await TenantPostRepo.create({
      values: { title: 'same-title', tenantId: 'tenant-b' },
      hooks: false,
    });
    const tenantAPost = await TenantPostRepo.create({
      values: { title: 'same-title', tenantId: 'tenant-a' },
      hooks: false,
    });

    return { tenantAPost, tenantBPost };
  }

  it('query should only read records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('query', {
      params: {
        filter: {
          title: 'same-title',
        },
      },
    });
    const { tenantAPost } = await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result.id).toBe(tenantAPost.id);
    expect(job.result.tenantId).toBe('tenant-a');
  });

  it('select should only read records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('select', {
      params: {
        filter: {
          title: 'same-title',
        },
      },
    });
    const { tenantAPost } = await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result.id).toBe(tenantAPost.id);
    expect(job.result.tenantId).toBe('tenant-a');
  });

  it('update should only modify records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('update', {
      params: {
        filter: {
          title: 'same-title',
        },
        values: {
          published: true,
        },
      },
    });
    const { tenantAPost, tenantBPost } = await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result.length).toBe(1);
    await tenantAPost.reload();
    await tenantBPost.reload();
    expect(tenantAPost.published).toBe(true);
    expect(tenantBPost.published).toBe(false);
  });

  it('updateorcreate should only update records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('updateorcreate', {
      params: {
        filter: {
          title: 'same-title',
        },
        values: {
          published: true,
        },
      },
    });
    const { tenantAPost, tenantBPost } = await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result).toBe(1);
    await tenantAPost.reload();
    await tenantBPost.reload();
    expect(tenantAPost.published).toBe(true);
    expect(tenantBPost.published).toBe(false);
  });

  it('destroy should only remove records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('destroy', {
      params: {
        filter: {
          title: 'same-title',
        },
      },
    });
    const { tenantAPost, tenantBPost } = await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result).toBe(1);
    expect(await TenantPostRepo.findById(tenantAPost.id)).toBeNull();
    expect(await TenantPostRepo.findById(tenantBPost.id)).toBeTruthy();
  });

  it('aggregate should only count records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('aggregate', {
      aggregator: 'count',
      params: {
        field: 'id',
        filter: {
          title: 'same-title',
        },
      },
    });
    await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result).toBe(1);
  });
});
