import { MockServer } from '@tachybase/test';
import { MockDatabase } from '@tego/server';

import { EXECUTION_STATUS, JOB_STATUS } from '../../constants';
import {
  createWorkflowTestAppCache,
  FAST_POLL_INTERVAL_MS,
  waitForFastAssertion as waitForAssertion,
  waitForWorkflowIdle,
} from '../utils';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('workflow > triggers > collection', () => {
  let app: MockServer;
  let db: MockDatabase;
  let CategoryRepo;
  let PostRepo;
  let CommentRepo;
  let TagRepo;
  let WorkflowModel;
  let withAnotherDataSource = false;
  let testPlugins = [];

  const tenantScopedCollectionName = 'tenant_trigger_workflow_posts';
  const tenantWorkflowTriggerCollectionName = 'tenant_workflow_trigger_events';
  const tenantInheritedCollectionName = 'tenant_inherited_trigger_workflow_posts';
  const appCache = createWorkflowTestAppCache<MockServer>((currentApp) => {
    app = currentApp;
    bindRepositories();
  });

  function bindRepositories() {
    db = app.db;
    WorkflowModel = db.getCollection('workflows').model;
    CategoryRepo = db.getCollection('categories').repository;
    PostRepo = db.getCollection('posts').repository;
    CommentRepo = db.getCollection('comments').repository;
    TagRepo = db.getCollection('tags').repository;
  }

  async function resetAppData() {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app, { interval: FAST_POLL_INTERVAL_MS });
    await db.getRepository('jobs').destroy({ filter: {} });
    await db.getRepository('executions').destroy({ filter: {} });
    await db.getRepository('workflows').destroy({ filter: {} });
    await CommentRepo.destroy({ filter: {} });
    await PostRepo.destroy({ filter: {} });
    await CategoryRepo.destroy({ filter: {} });
    await TagRepo.destroy({ filter: {} });
    if (db.hasCollection(tenantScopedCollectionName)) {
      await db.getRepository(tenantScopedCollectionName).destroy({ filter: {} });
    }
    if (db.hasCollection(tenantWorkflowTriggerCollectionName)) {
      await db.getRepository(tenantWorkflowTriggerCollectionName).destroy({ filter: {} });
    }
    if (db.hasCollection(tenantInheritedCollectionName)) {
      await db.getRepository(tenantInheritedCollectionName).destroy({ filter: {} });
    }

    if (withAnotherDataSource) {
      // @ts-ignore
      const anotherDB = app.dataSourceManager.dataSources.get('another').collectionManager.db;
      await anotherDB.getRepository('posts').destroy({ filter: {} });
    }
  }

  beforeEach(async () => {
    await appCache.useApp({ plugins: testPlugins, withAnotherDataSource });
    await resetAppData();
  });

  afterEach(async () => {
    await waitForWorkflowIdle(app, { interval: FAST_POLL_INTERVAL_MS });
  });

  afterAll(async () => {
    await appCache.destroy();
  });

  async function ensureTenantWorkflowCollection(name: string, tenancy: 'tenantScoped' | 'tenantInherited') {
    if (!db.hasCollection(name)) {
      db.collection({
        name,
        tenancy,
        fields: [
          { type: 'string', name: 'title' },
          { type: 'string', name: 'tenantId' },
          { type: 'boolean', name: 'published', defaultValue: false },
        ],
      });
      await db.sync();
    }

    return db.getRepository(name);
  }

  function tenantState(
    tenantId: string,
    currentTenancyMode: 'tenantScoped' | 'tenantInherited' = 'tenantScoped',
    currentTenantDescendantIds: string[] = [],
  ) {
    return {
      currentTenant: { id: tenantId, name: tenantId, title: tenantId },
      currentTenantId: tenantId,
      currentTenantDescendantIds,
      currentTenancyMode,
    };
  }

  describe('toggle', () => {
    it('create without config should ok', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {},
      });

      expect(workflow).toBeDefined();
    });

    it('when collection change', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      await workflow.update({
        config: {
          ...workflow.config,
          collection: 'comments',
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowIdle(app, { interval: FAST_POLL_INTERVAL_MS });

      const executions = await workflow.getExecutions();
      expect(executions.length).toBe(0);
    });
  });

  describe('collection-manager integration', () => {
    beforeAll(() => {
      testPlugins = ['collection-manager'];
    });

    afterAll(() => {
      testPlugins = [];
    });

    it('restart server and listen a collection managed by collection-manager', async () => {
      await db.getRepository('collections').create({
        values: {
          name: 'temp',
          title: 'Temp',
        },
        // to trigger collection sync to db.collections
        context: {},
      });

      const workflow = await WorkflowModel.create({
        type: 'collection',
        config: {
          mode: 1,
          collection: 'temp',
        },
        enabled: true,
      });

      await db.getRepository('temp').create({ values: {} });

      await waitForAssertion(async () => {
        const e1 = await workflow.getExecutions();
        expect(e1.length).toBe(1);
      });

      await app.restart();

      db = app.db;

      await db.getRepository('temp').create({ values: {} });

      await waitForAssertion(async () => {
        const e2 = await db.getModel('executions').findAll();
        expect(e2.length).toBe(2);
      });
    });
  });

  describe('model context', () => {
    it('should persist tenant context from repository options', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      await PostRepo.create({
        values: { title: 't1' },
        context: {
          state: {
            currentTenant: { id: 'tenant-a', name: 'tenant-a' },
            currentTenantId: 'tenant-a',
            currentTenantDescendantIds: ['tenant-a', 'tenant-a-child'],
            currentRole: 'admin',
            currentUser: { id: 1, password: 'secret' },
          },
        },
      });

      await sleep(500);

      const executions = await workflow.getExecutions();
      expect(executions.length).toBe(1);
      expect(executions[0].tenantId).toBe('tenant-a');
      expect(executions[0].tenantContext).toMatchObject({
        currentTenant: { id: 'tenant-a', name: 'tenant-a' },
        currentTenantId: 'tenant-a',
        currentTenantDescendantIds: ['tenant-a', 'tenant-a-child'],
      });
      expect(executions[0].context.state.currentRole).toBeUndefined();
      expect(executions[0].context.state.currentUser).toBeUndefined();
    });

    it('with association', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const post = await PostRepo.create({ values: { title: 't1', category: { title: 'c1' } } });

      await waitForAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.length).toBe(1);
        expect(executions[0].context.data.title).toBe('t1');
        expect(executions[0].context.data.category.title).toBe('c1');
      });
    });
  });

  describe('tenant context integration', () => {
    it('collection trigger should run query, update, and create nodes in the current tenant', async () => {
      const TenantTriggerRepo = await ensureTenantWorkflowCollection(
        tenantWorkflowTriggerCollectionName,
        'tenantScoped',
      );
      const TenantPostRepo = await ensureTenantWorkflowCollection(tenantScopedCollectionName, 'tenantScoped');
      const rootPost = await TenantPostRepo.create({
        values: { title: 'shared-target', tenantId: 'root', published: false },
        hooks: false,
      });
      const adminPost = await TenantPostRepo.create({
        values: { title: 'shared-target', tenantId: 'admin1', published: false },
        hooks: false,
      });

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: tenantWorkflowTriggerCollectionName,
        },
      });
      const queryNode = await workflow.createNode({
        type: 'query',
        config: {
          collection: tenantScopedCollectionName,
          params: {
            filter: {
              title: 'shared-target',
            },
          },
        },
      });
      const updateNode = await workflow.createNode({
        type: 'update',
        config: {
          collection: tenantScopedCollectionName,
          params: {
            filter: {
              title: 'shared-target',
            },
            values: {
              published: true,
              tenantId: 'root',
            },
          },
        },
        upstreamId: queryNode.id,
      });
      const createNode = await workflow.createNode({
        type: 'create',
        config: {
          collection: tenantScopedCollectionName,
          params: {
            values: {
              title: 'created-by-workflow',
              tenantId: 'root',
              published: true,
            },
          },
        },
        upstreamId: updateNode.id,
      });
      await queryNode.setDownstream(updateNode);
      await updateNode.setDownstream(createNode);

      const workflowPlugin = app.pm.get('workflow') as any;
      const originalDispatch = workflowPlugin.dispatch.bind(workflowPlugin);
      workflowPlugin.dispatch = () => {};

      try {
        await TenantTriggerRepo.create({
          values: { title: 'trigger-admin1', tenantId: 'admin1' },
          context: {
            state: tenantState('admin1'),
          },
        });

        let queuedExecution;
        await waitForAssertion(async () => {
          const executions = await workflow.getExecutions();
          expect(executions.length).toBe(1);
          expect(executions[0].status).toBe(EXECUTION_STATUS.QUEUEING);
          expect(executions[0].tenantId).toBe('admin1');
          expect(executions[0].tenantContext).toMatchObject({
            currentTenant: { id: 'admin1', name: 'admin1', title: 'admin1' },
            currentTenantId: 'admin1',
            currentTenantDescendantIds: [],
            currentTenancyMode: 'tenantScoped',
          });
          queuedExecution = executions[0];
        });

        workflowPlugin.pending = [];
        await workflowPlugin.process(queuedExecution);

        await waitForAssertion(async () => {
          const executions = await workflow.getExecutions();
          expect(executions.length).toBe(1);
          expect(executions[0].status).toBe(EXECUTION_STATUS.RESOLVED);
          expect(executions[0].tenantId).toBe('admin1');
          expect(executions[0].tenantContext).toMatchObject({
            currentTenant: { id: 'admin1', name: 'admin1', title: 'admin1' },
            currentTenantId: 'admin1',
            currentTenantDescendantIds: [],
            currentTenancyMode: 'tenantScoped',
          });
          expect(executions[0].context.state).toMatchObject({
            currentTenantId: 'admin1',
            currentTenancyMode: 'tenantScoped',
          });

          const jobs = await executions[0].getJobs({ order: [['id', 'ASC']] });
          expect(jobs.length).toBe(3);
          expect(jobs.map((job) => job.status)).toEqual([
            JOB_STATUS.RESOLVED,
            JOB_STATUS.RESOLVED,
            JOB_STATUS.RESOLVED,
          ]);
          expect(jobs[0].result.id).toBe(adminPost.id);
          expect(jobs[0].result.tenantId).toBe('admin1');
          expect(jobs[1].result.length).toBe(1);
          expect(jobs[2].result.title).toBe('created-by-workflow');
          expect(jobs[2].result.tenantId).toBe('admin1');
        });

        await waitForWorkflowIdle(app, { interval: FAST_POLL_INTERVAL_MS });
      } finally {
        workflowPlugin.pending = [];
        workflowPlugin.events = [];
        workflowPlugin.dispatch = originalDispatch;
      }

      await rootPost.reload();
      await adminPost.reload();
      expect(rootPost.published).toBe(false);
      expect(adminPost.published).toBe(true);

      const createdPosts = await TenantPostRepo.find({
        filter: {
          title: 'created-by-workflow',
        },
      });
      expect(createdPosts.length).toBe(1);
      expect(createdPosts[0].tenantId).toBe('admin1');
    });

    it('tenantInherited query nodes should let parents see children but not children see parents', async () => {
      const TenantPostRepo = await ensureTenantWorkflowCollection(tenantInheritedCollectionName, 'tenantInherited');
      await TenantPostRepo.create({
        values: { title: 'inherited-target', tenantId: 'root' },
        hooks: false,
      });
      await TenantPostRepo.create({
        values: { title: 'inherited-target', tenantId: 'admin1' },
        hooks: false,
      });

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: tenantInheritedCollectionName,
        },
      });
      await workflow.createNode({
        type: 'query',
        config: {
          collection: tenantInheritedCollectionName,
          multiple: true,
          params: {
            filter: {
              title: 'inherited-target',
            },
          },
        },
      });

      await TenantPostRepo.create({
        values: { title: 'trigger-root', tenantId: 'root' },
        context: {
          state: tenantState('root', 'tenantInherited', ['admin1']),
        },
      });

      await waitForAssertion(async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(execution.tenantId).toBe('root');
        expect(execution.tenantContext).toMatchObject({
          currentTenantId: 'root',
          currentTenantDescendantIds: ['admin1'],
          currentTenancyMode: 'tenantInherited',
        });

        const [job] = await execution.getJobs();
        const tenantIds = job.result.map((item) => item.tenantId).sort();
        expect(tenantIds).toEqual(['admin1', 'root']);
      });

      await TenantPostRepo.create({
        values: { title: 'trigger-admin1', tenantId: 'admin1' },
        context: {
          state: tenantState('admin1', 'tenantInherited'),
        },
      });

      await waitForAssertion(async () => {
        const executions = await workflow.getExecutions({ order: [['createdAt', 'ASC']] });
        expect(executions.length).toBe(2);
        expect(executions[1].status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(executions[1].tenantId).toBe('admin1');
        expect(executions[1].tenantContext).toMatchObject({
          currentTenantId: 'admin1',
          currentTenantDescendantIds: [],
          currentTenancyMode: 'tenantInherited',
        });

        const [job] = await executions[1].getJobs();
        const tenantIds = job.result.map((item) => item.tenantId).sort();
        expect(tenantIds).toEqual(['admin1']);
      });
    });

    it('tenant-scoped collection workflow should not crash without tenant context', async () => {
      const TenantPostRepo = await ensureTenantWorkflowCollection(tenantScopedCollectionName, 'tenantScoped');
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: tenantScopedCollectionName,
        },
      });
      await workflow.createNode({
        type: 'query',
        config: {
          collection: tenantScopedCollectionName,
          params: {
            filter: {
              title: 'no-tenant-context',
            },
          },
        },
      });

      await TenantPostRepo.create({
        values: { title: 'no-tenant-context' },
      });

      await waitForAssertion(async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(execution.tenantId).toBeFalsy();
        expect(execution.tenantContext).toBeFalsy();

        const [job] = await execution.getJobs();
        expect(job.status).toBe(JOB_STATUS.RESOLVED);
        expect(job.result.title).toBe('no-tenant-context');
      });
    });
  });

  describe('config.changed', () => {
    it('no changed config', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 2,
          collection: 'posts',
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });
      await PostRepo.update({ filterByTk: post.id, values: { title: 't2' } });

      await waitForAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.length).toBe(1);
        expect(executions[0].context.data.title).toBe('t2');
      });
    });

    it('field in changed config', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 2,
          collection: 'posts',
          changed: ['title'],
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });
      await PostRepo.update({ filterByTk: post.id, values: { title: 't2' } });

      await waitForAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.length).toBe(1);
        expect(executions[0].status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(executions[0].context.data.title).toBe('t2');
      });
    });

    it('field not in changed config', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 2,
          collection: 'posts',
          changed: ['published'],
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });
      await PostRepo.update({ filterByTk: post.id, values: { title: 't2' } });

      await waitForWorkflowIdle(app, { interval: FAST_POLL_INTERVAL_MS });

      const executions = await workflow.getExecutions();
      expect(executions.length).toBe(0);
    });
  });

  describe('config.appends', () => {
    it('non-appended association could not be accessed', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      await workflow.createNode({
        type: 'echo',
      });

      const category = await CategoryRepo.create({ values: { title: 'c1' } });

      const post = await PostRepo.create({
        values: {
          title: 't1',
          categoryId: category.id,
        },
      });

      await waitForAssertion(async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        const [job] = await execution.getJobs();
        expect(job).toBeTruthy();
        expect(job.result.data.category).toBeUndefined();
      });
    });

    it('appends association could be accessed', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
          appends: ['category'],
        },
      });

      await workflow.createNode({
        type: 'echo',
      });

      const category = await CategoryRepo.create({ values: { title: 'c1' } });

      const post = await PostRepo.create({
        values: {
          title: 't1',
          categoryId: category.id,
        },
      });

      await waitForAssertion(async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        const [job] = await execution.getJobs();
        expect(job.result.data.category.title).toBe('c1');
      });
    });

    it('appends belongsTo null', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
          appends: ['category'],
        },
      });

      await workflow.createNode({
        type: 'echo',
      });

      const post = await PostRepo.create({
        values: {
          title: 't1',
        },
      });

      await waitForAssertion(async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        const [job] = await execution.getJobs();
        expect(job.result.data.category).toBeNull();
      });
    });

    it('appends hasMany', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
          appends: ['comments'],
        },
      });

      await workflow.createNode({
        type: 'echo',
      });

      const comments = await CommentRepo.create({ values: [{}] });

      const post = await PostRepo.create({
        values: {
          title: 't1',
          comments: comments.map((item) => item.id),
        },
      });

      await waitForAssertion(async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        const [job] = await execution.getJobs();
        expect(job.result.data.comments.length).toBe(1);
      });
    });

    it('appends belongsToMany', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
          appends: ['tags'],
        },
      });

      await workflow.createNode({
        type: 'echo',
      });

      const tags = await TagRepo.create({ values: [{}] });

      const post = await PostRepo.create({
        values: {
          title: 't1',
          tags: tags.map((item) => item.id),
        },
      });

      await waitForAssertion(async () => {
        const [execution] = await workflow.getExecutions();
        expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
        const [job] = await execution.getJobs();
        expect(job.result.data.tags.length).toBe(1);
      });
    });

    describe('appends depth > 1', () => {
      it('create with associtions', async () => {
        const workflow = await WorkflowModel.create({
          enabled: true,
          type: 'collection',
          config: {
            mode: 1,
            collection: 'categories',
            appends: ['posts.tags'],
          },
        });

        const tags = await TagRepo.create({ values: [{}] });
        const tagIds = tags.map((item) => item.id);

        const category = await CategoryRepo.create({
          values: {
            title: 't1',
            posts: [
              { title: 't1', tags: tagIds },
              { title: 't2', tags: tagIds },
            ],
          },
        });

        await waitForAssertion(async () => {
          const [execution] = await workflow.getExecutions();
          expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
          expect(execution.context.data.posts.length).toBe(2);
          expect(execution.context.data.posts.map((item) => item.title)).toEqual(['t1', 't2']);
          expect(execution.context.data.posts.map((item) => item.tags.map((tag) => tag.id))).toEqual([tagIds, tagIds]);
        });
      });
    });
  });

  describe('cycling trigger', () => {
    it('trigger should not be triggered more than once in same execution', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const n1 = await workflow.createNode({
        type: 'create',
        config: {
          collection: 'posts',
          params: {
            values: {
              title: 't2',
            },
          },
        },
      });

      const p1 = await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const posts = await PostRepo.find();
        expect(posts.length).toBe(2);

        const e1s = await workflow.getExecutions();
        expect(e1s.length).toBe(1);
        expect(e1s[0].status).toBe(EXECUTION_STATUS.RESOLVED);
      });

      // NOTE: second trigger to ensure no skipped event
      const p3 = await PostRepo.create({ values: { title: 't3' } });

      await waitForAssertion(async () => {
        const posts2 = await PostRepo.find();
        expect(posts2.length).toBe(4);

        const e2s = await workflow.getExecutions({ order: [['createdAt', 'DESC']] });
        expect(e2s.length).toBe(2);
        expect(e2s[1].status).toBe(EXECUTION_STATUS.RESOLVED);
      });
    });

    it('multiple cycling trigger should not trigger more than once', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const n1 = await w1.createNode({
        type: 'create',
        config: {
          collection: 'categories',
          params: {
            values: {
              title: 'c1',
            },
          },
        },
      });

      const w2 = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'categories',
        },
      });

      const n2 = await w2.createNode({
        type: 'create',
        config: {
          collection: 'posts',
          params: {
            values: {
              title: 't2',
            },
          },
        },
      });

      const p1 = await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const posts = await PostRepo.find();
        expect(posts.length).toBe(2);

        const e1s = await w1.getExecutions();
        expect(e1s.length).toBe(1);
        expect(e1s[0].status).toBe(EXECUTION_STATUS.RESOLVED);

        const e2s = await w2.getExecutions();
        expect(e2s.length).toBe(1);
        expect(e2s[0].status).toBe(EXECUTION_STATUS.RESOLVED);
      });
      await waitForWorkflowIdle(app, { interval: FAST_POLL_INTERVAL_MS });
      await waitForAssertion(async () => {
        const posts = await PostRepo.find();
        expect(posts.length).toBe(2);

        const e1s = await w1.getExecutions();
        expect(e1s.length).toBe(1);

        const e2s = await w2.getExecutions();
        expect(e2s.length).toBe(1);
      });
    });
  });

  describe('sync', () => {
    it('sync collection trigger', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        sync: true,
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const n1 = await workflow.createNode({
        type: 'create',
        config: {
          collection: 'comments',
          params: {
            values: {},
          },
        },
      });

      await PostRepo.create({ values: { title: 't1' } });

      const executions = await workflow.getExecutions();
      expect(executions.length).toBe(1);
      expect(executions[0].status).toBe(EXECUTION_STATUS.RESOLVED);
    });
  });

  describe('multiple data source', () => {
    let anotherDB: MockDatabase;
    beforeAll(() => {
      withAnotherDataSource = true;
      testPlugins = ['users', 'auth'];
    });
    afterAll(() => {
      withAnotherDataSource = false;
      testPlugins = [];
    });

    beforeEach(async () => {
      // @ts-ignore
      anotherDB = app.dataSourceManager.dataSources.get('another').collectionManager.db;
    });

    it('collection trigger on another', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'another:posts',
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowIdle(app, { interval: FAST_POLL_INTERVAL_MS });

      const e1s = await workflow.getExecutions();
      expect(e1s.length).toBe(0);

      const AnotherPostRepo = anotherDB.getRepository('posts');
      const anotherPost = await AnotherPostRepo.create({ values: { title: 't2' } });

      await waitForAssertion(async () => {
        const e2s = await workflow.getExecutions();
        expect(e2s.length).toBe(1);
        expect(e2s[0].status).toBe(EXECUTION_STATUS.RESOLVED);
        expect(e2s[0].context.data.title).toBe('t2');
      });

      const p1s = await PostRepo.find();
      expect(p1s.length).toBe(1);

      const p2s = await AnotherPostRepo.find();
      expect(p2s.length).toBe(1);
    });

    it('revisiond workflow should only trigger on enabled version', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'another:posts',
        },
      });

      const AnotherPostRepo = anotherDB.getRepository('posts');
      const p1 = await AnotherPostRepo.create({ values: { title: 't2' } });

      await waitForAssertion(async () => {
        const e1s = await w1.getExecutions();
        expect(e1s.length).toBe(1);
        expect(e1s[0].status).toBe(EXECUTION_STATUS.RESOLVED);
      });

      const user = await app.db.getRepository('users').findOne();
      const agent = app.agent().login(user);

      const { body, status } = await agent.resource('workflows').revision({
        filterByTk: w1.id,
        filter: {
          key: w1.key,
        },
      });
      expect(status).toBe(200);
      const w2 = await WorkflowModel.findByPk(body.data.id);
      expect(w2).toBeTruthy();
      await w2.update({ enabled: true });
      expect(w2.enabled).toBe(true);

      await w1.reload();
      expect(w1.enabled).toBe(false);

      const p2 = await AnotherPostRepo.create({ values: { title: 't2' } });

      const ExecutionRepo = app.db.getRepository('executions');
      await waitForAssertion(async () => {
        const e2s = await w1.getExecutions({ order: [['createdAt', 'ASC']] });
        expect(e2s.length).toBe(1);

        const e3s = await ExecutionRepo.find({
          filter: {
            workflowId: w2.id,
          },
        });
        expect(e3s.length).toBe(1);
      });
    });
  });
});
