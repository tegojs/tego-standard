import { getApp } from '@tachybase/plugin-workflow-test';
import Database, { Application } from '@tego/server';

import WorkflowPlugin, { JOB_STATUS } from '../..';

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

  it('create should inject tenantId from execution context', async () => {
    const workflow = await createWorkflowWithNode('create', {
      params: {
        values: {
          title: 'new-post',
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result.title).toBe('new-post');
    expect(job.result.tenantId).toBe('tenant-a');

    const allPosts = await TenantPostRepo.find({ filter: { title: 'new-post' } });
    expect(allPosts.length).toBe(1);
    expect(allPosts[0].tenantId).toBe('tenant-a');
  });

  it('create should isolate records between tenants', async () => {
    const workflowA = await createWorkflowWithNode('create', {
      params: {
        values: {
          title: 'isolated-post',
        },
      },
    });

    await plugin.trigger(
      workflowA,
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

    const [executionA] = await workflowA.getExecutions();
    const [jobA] = await executionA.getJobs();
    expect(jobA.result.tenantId).toBe('tenant-a');

    const workflowB = await WorkflowModel.create({
      enabled: true,
      type: 'syncTrigger',
    });
    await workflowB.createNode({
      type: 'create',
      config: {
        collection: collectionName,
        params: {
          values: {
            title: 'isolated-post',
          },
        },
      },
    });

    const tenantBContext = {
      currentTenant: { id: 'tenant-b', name: 'tenant-b' },
      currentTenantId: 'tenant-b',
      currentTenantDescendantIds: [],
      currentTenancyMode: 'tenantScoped',
    };

    await plugin.trigger(
      workflowB,
      {
        data: {},
        state: tenantBContext,
      },
      {
        context: {
          state: tenantBContext,
        },
      },
    );

    const [executionB] = await workflowB.getExecutions();
    const [jobB] = await executionB.getJobs();
    expect(jobB.result.tenantId).toBe('tenant-b');

    const allPosts = await TenantPostRepo.find({ filter: { title: 'isolated-post' } });
    expect(allPosts.length).toBe(2);
    const tenantIds = allPosts.map((p) => p.tenantId).sort();
    expect(tenantIds).toEqual(['tenant-a', 'tenant-b']);
  });

  describe('sql instruction tenant isolation boundary', () => {
    it('sql instruction does NOT apply tenant filtering — by design', async () => {
      // The SQL instruction executes raw SQL and bypasses the repository layer.
      // It does NOT call applyTenantFilterToContext() and therefore does not
      // scope queries to the execution's tenant.
      //
      // This test documents that behavior as a deliberate design decision.
      // SQL statements are opaque to the framework and cannot be safely rewritten.
      // Workflow authors must manually include tenantId conditions in their SQL.
      //
      // See: docs/tenant-data-source-isolation-evaluation.md §4.1 第三步
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'syncTrigger',
      });

      const tableName = TenantPostRepo.collection.model.tableName;
      await workflow.createNode({
        type: 'sql',
        config: {
          sql: `SELECT * FROM ${db.queryInterface.quoteIdentifier(tableName)}`,
        },
      });

      await createSameTitleTenantPosts();

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

      expect(job.status).toBe(JOB_STATUS.RESOLVED);
      // SQL returns ALL rows (both tenant-a and tenant-b) because it does NOT
      // apply tenant filtering. This is the expected behavior.
      const rows = job.result[0]; // sequelize.query returns [rows, metadata]
      expect(rows.length).toBe(2);
    });
  });
});
