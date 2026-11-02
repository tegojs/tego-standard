import { getApp } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database, { type Transaction } from '@tego/server';

import Plugin from '..';
import { EXECUTION_STATUS } from '../constants';
import { waitForFastAssertion as waitForAssertion, waitForWorkflowIdle } from './utils';

describe('workflow > Plugin', () => {
  let app: MockServer;
  let db: Database;
  let PostRepo;
  let WorkflowModel;
  let plugin;

  beforeAll(async () => {
    app = await getApp();
    db = app.db;
    WorkflowModel = db.getCollection('workflows').model;
    PostRepo = db.getCollection('posts').repository;
    plugin = app.pm.get('workflow') as any;
  });

  beforeEach(async () => {
    if (plugin) {
      plugin.ready = true;
    }
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
    await db.getRepository('jobs').destroy({ filter: {} });
    await db.getRepository('executions').destroy({ filter: {} });
    await db.getRepository('workflows').destroy({ filter: {} });
    await PostRepo.destroy({ filter: {} });
  });

  afterEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
  });

  afterAll(() => app.destroy());

  describe('create', () => {
    it('create with enabled', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      expect(workflow.current).toBe(true);
    });

    it('create with disabled', async () => {
      const workflow = await WorkflowModel.create({
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      expect(workflow.current).toBe(true);
    });
  });

  describe('update', () => {
    it('toggle on', async () => {
      const workflow = await WorkflowModel.create({
        enabled: false,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });
      expect(workflow.current).toBe(true);

      const p1 = await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowIdle(app);

      const count = await workflow.countExecutions();
      expect(count).toBe(0);

      await workflow.update({ enabled: true });
      expect(workflow.current).toBe(true);

      const p2 = await PostRepo.create({ values: { title: 't2' } });

      await waitForAssertion(async () => {
        const executions = await workflow.getExecutions();
        expect(executions.length).toBe(1);
      });
    });

    it('toggle off', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });
      expect(workflow.current).toBe(true);

      const p1 = await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const c1 = await workflow.countExecutions();
        expect(c1).toBe(1);
      });

      await workflow.update({ enabled: false });
      expect(workflow.current).toBe(true);

      const p2 = await PostRepo.create({ values: { title: 't2' } });

      await waitForAssertion(async () => {
        const c2 = await workflow.countExecutions();
        expect(c2).toBe(1);
      });
    });

    it('toggle off then on', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const p1 = await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const c1 = await workflow.countExecutions();
        expect(c1).toBe(1);
      });

      await workflow.update({
        enabled: false,
      });
      expect(workflow.current).toBe(true);

      const p2 = await PostRepo.create({ values: { title: 't2' } });

      await waitForWorkflowIdle(app);

      const c2 = await workflow.countExecutions();
      expect(c2).toBe(1);

      await workflow.update({
        enabled: true,
      });
      expect(workflow.current).toBe(true);

      const p3 = await PostRepo.create({ values: { title: 't3' } });

      await waitForAssertion(async () => {
        const c3 = await workflow.countExecutions();
        expect(c3).toBe(2);
      });
    });

    it('update config', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const p1 = await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const c1 = await workflow.countExecutions();
        expect(c1).toBe(1);
      });

      await workflow.update({
        config: {
          mode: 1,
          collection: 'tags',
        },
      });

      const p2 = await PostRepo.create({ values: { title: 't2' } });

      await waitForWorkflowIdle(app);

      const c2 = await workflow.countExecutions();
      expect(c2).toBe(1);
    });
  });

  describe('destroy', () => {
    it('destroyed workflow will not be trigger any more', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const n1 = await workflow.createNode({
        type: 'update',
        config: {
          collection: 'posts',
          params: {
            filter: {
              id: '{{$context.data.id}}',
            },
            values: {
              title: 't2',
            },
          },
        },
      });

      await PostRepo.create({ values: { title: 't1' } });

      const { model: JobModel } = db.getCollection('jobs');

      await waitForAssertion(async () => {
        const e1c = await workflow.countExecutions();
        expect(e1c).toBe(1);
        const j1c = await JobModel.count();
        expect(j1c).toBe(1);
        const p1 = await PostRepo.findOne();
        expect(p1.title).toBe('t2');
      });

      await workflow.destroy();

      await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowIdle(app);

      const p2c = await PostRepo.count({ filter: { title: 't1' } });
      expect(p2c).toBe(1);
    });
  });

  describe('dispatcher', () => {
    it('releases a failed durable queue scan and resumes the persisted tenant task on the next restart', async () => {
      db.collection({
        name: 'queueFailureTenantResults',
        tenancy: 'tenantScoped',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'title', type: 'string' },
        ],
      });
      await db.sync();
      const workflow = await WorkflowModel.create({ enabled: true, type: 'asyncTrigger' });
      await workflow.createNode({
        type: 'create',
        config: { collection: 'queueFailureTenantResults', params: { values: { title: 'Recovered tenant task' } } },
      });
      await app.stop();
      await db.reconnect();
      const execution = await workflow.createExecution({
        key: workflow.key,
        status: EXECUTION_STATUS.QUEUEING,
        context: {},
        tenantId: 'B',
        tenantContext: {
          currentTenant: { id: 'B' },
          currentTenantId: 'B',
          currentTenancyMode: 'tenantScoped',
          currentTenantDescendantIds: [],
          currentLegacyDataTenantIds: [],
        },
      });
      const model = db.getCollection('executions').model;
      let queryIntercepted = false;
      model.addHook('beforeFind', 'fail-durable-queue', (options) => {
        if (!options.include) return;
        queryIntercepted = true;
        model.removeHook('beforeFind', 'fail-durable-queue');
        options.where = { missingQueueDiscoveryColumn: true };
      });
      const errors = vi.spyOn(plugin.getLogger('dispatcher'), 'error');
      const scans: Promise<unknown>[] = [];
      const original = plugin.dispatch.bind(plugin);
      // Observe the actual scan's settlement so the RED does not create an unhandled rejection in the runner.
      const observe = vi.spyOn(plugin, 'dispatch').mockImplementation(() => {
        original();
        if (plugin.executing) scans.push(Promise.resolve(plugin.executing).catch((error) => error));
      });
      try {
        await app.start();
        const outcomes = await Promise.all(scans);
        expect(queryIntercepted).toBe(true);
        const queryFailure =
          errors.mock.calls[0]?.[1] ??
          outcomes.find((value) => (value as { name?: string })?.name === 'SequelizeDatabaseError');
        expect(queryFailure).toMatchObject({ name: 'SequelizeDatabaseError' });
        expect((queryFailure as Error).message).toMatch(/no such column/);
        expect(errors).toHaveBeenCalledWith(
          'failed to discover queued workflow executions',
          expect.objectContaining({ name: 'SequelizeDatabaseError' }),
        );
        expect(plugin.executing).toBeFalsy();
        expect((await execution.reload()).status).toBe(EXECUTION_STATUS.QUEUEING);
        expect(await db.getCollection('queueFailureTenantResults').model.count()).toBe(0);

        await app.stop();
        await app.start();
        await waitForWorkflowIdle(app);
        expect((await execution.reload()).status).toBe(EXECUTION_STATUS.RESOLVED);
        const results = await db.getCollection('queueFailureTenantResults').model.findAll();
        expect(results.map((row) => [row.get('tenantId'), row.get('title')])).toEqual([['B', 'Recovered tenant task']]);
      } finally {
        model.removeHook('beforeFind', 'fail-durable-queue');
        await Promise.allSettled(scans);
        // Only discard this fixture's already settled observation, including the pre-fix rejected promise.
        plugin.executing = null;
        observe.mockRestore();
        errors.mockRestore();
      }
    });

    it('multiple triggers in same event', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const w2 = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const w3 = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const p1 = await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const [e1] = await w1.getExecutions();
        expect(e1.status).toBe(EXECUTION_STATUS.RESOLVED);

        const [e2] = await w2.getExecutions();
        expect(e2.status).toBe(EXECUTION_STATUS.RESOLVED);

        const [e3] = await w3.getExecutions();
        expect(e3.status).toBe(EXECUTION_STATUS.RESOLVED);
      });
      await waitForWorkflowIdle(app);
    });

    it('multiple events on same workflow', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const p1 = await PostRepo.create({ values: { title: 't1' } });
      const p2 = await PostRepo.create({ values: { title: 't2' } });
      const p3 = await PostRepo.create({ values: { title: 't3' } });

      await waitForAssertion(async () => {
        const executions = await w1.getExecutions();
        expect(executions.length).toBe(3);
        expect(executions.map((item) => item.status)).toEqual(Array(3).fill(EXECUTION_STATUS.RESOLVED));
      });
      await waitForWorkflowIdle(app);
    });

    it('when server starts, process all created executions', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      await app.stop();

      await db.reconnect();

      const p1 = await PostRepo.create({ values: { title: 't1' } });

      const ExecutionModel = db.getCollection('executions').model;
      const e1 = await w1.createExecution({
        key: w1.key,
        context: {
          data: p1.get(),
        },
      });

      await app.start();

      await waitForAssertion(async () => {
        await e1.reload();
        expect(e1.status).toBe(EXECUTION_STATUS.RESOLVED);
      });

      await w1.update({ enabled: false });

      await app.stop();

      await db.reconnect();

      const e2 = await w1.createExecution({
        key: w1.key,
        context: {
          data: p1.get(),
        },
        createdAt: p1.createdAt,
      });

      const w2 = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const e3 = await w2.createExecution({
        key: w2.key,
        context: {
          data: p1.get(),
        },
      });

      await app.start();

      await waitForAssertion(async () => {
        await e2.reload();
        expect(e2.status).toBe(EXECUTION_STATUS.QUEUEING);

        // queueing execution of disabled workflow should not effect other executions
        await e3.reload();
        expect(e3.status).toBe(EXECUTION_STATUS.RESOLVED);
      });
    });
  });

  describe('options.deleteExecutionOnStatus', () => {
    it('no configured should not be deleted', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      const p1 = await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const executions = await w1.getExecutions();
        expect(executions.length).toBe(1);
      });
    });

    it('status on started should not be deleted', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        options: {
          deleteExecutionOnStatus: [EXECUTION_STATUS.STARTED],
        },
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      await w1.createNode({
        type: 'pending',
      });

      const p1 = await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const executions = await w1.getExecutions();
        expect(executions.length).toBe(1);
        expect(executions[0].status).toBe(EXECUTION_STATUS.STARTED);
      });
    });

    it('configured resolved status should be deleted', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        options: {
          deleteExecutionOnStatus: [EXECUTION_STATUS.RESOLVED],
        },
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });
      const destroyedExecutions: Array<{ status: number; workflowId: number }> = [];
      const listener = (execution) => {
        destroyedExecutions.push({
          status: execution.status,
          workflowId: execution.workflowId,
        });
      };
      db.on('executions.beforeDestroy', listener);

      try {
        await PostRepo.create({ values: { title: 't1' } });

        await waitForAssertion(async () => {
          expect(destroyedExecutions).toContainEqual({
            status: EXECUTION_STATUS.RESOLVED,
            workflowId: w1.id,
          });
          const executions = await w1.getExecutions();
          expect(executions.length).toBe(0);
        });
      } finally {
        db.off('executions.beforeDestroy', listener);
      }
    });

    it('configured error status should be deleted', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        options: {
          deleteExecutionOnStatus: [EXECUTION_STATUS.ERROR],
        },
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });

      await w1.createNode({
        type: 'error',
      });
      const destroyedExecutions: Array<{ status: number; workflowId: number }> = [];
      const listener = (execution) => {
        destroyedExecutions.push({
          status: execution.status,
          workflowId: execution.workflowId,
        });
      };
      db.on('executions.beforeDestroy', listener);

      try {
        await PostRepo.create({ values: { title: 't1' } });

        await waitForAssertion(async () => {
          expect(destroyedExecutions).toContainEqual({
            status: EXECUTION_STATUS.ERROR,
            workflowId: w1.id,
          });
          const executions = await w1.getExecutions();
          expect(executions.length).toBe(0);
        });
      } finally {
        db.off('executions.beforeDestroy', listener);
      }
    });

    it('configured child workflow status should be deleted after resuming parent workflow', async () => {
      const childWorkflow = await WorkflowModel.create({
        enabled: true,
        type: 'asyncTrigger',
        options: {
          deleteExecutionOnStatus: [EXECUTION_STATUS.RESOLVED],
        },
      });

      const parentWorkflow = await WorkflowModel.create({
        enabled: true,
        type: 'collection',
        config: {
          mode: 1,
          collection: 'posts',
        },
      });
      await parentWorkflow.createNode({
        type: 'trigger-instruction',
        config: {
          workflowKey: childWorkflow.key,
        },
      });

      await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const parentExecutions = await parentWorkflow.getExecutions();
        expect(parentExecutions.length).toBe(1);
        expect(parentExecutions[0].status).toBe(EXECUTION_STATUS.RESOLVED);

        const childExecutions = await childWorkflow.getExecutions();
        expect(childExecutions.length).toBe(0);
      });
    });
  });

  describe('sync', () => {
    it('leaves a caller transaction open after a real event-validation SQL failure', async () => {
      const workflow = await WorkflowModel.create({ enabled: true, type: 'syncTrigger' });
      const transaction = await db.sequelize.transaction();
      const validation = vi
        .spyOn(plugin.triggers.get('syncTrigger'), 'validateEvent')
        .mockImplementation(async (_workflow, _context, options: { transaction?: Transaction }) => {
          await db.sequelize.query('SELECT * FROM missing_workflow_validation_source', {
            transaction: options.transaction,
          });
          return true;
        });
      try {
        const post = await PostRepo.create({ values: { title: 'Caller owns this change' }, transaction });
        expect(await plugin.trigger(workflow, {}, { transaction })).toBeNull();
        expect(transaction.finished).toBeFalsy();
        expect((await PostRepo.findOne({ filterByTk: post.id, transaction })).title).toBe('Caller owns this change');
        await transaction.commit();
        expect((await PostRepo.findOne({ filterByTk: post.id })).title).toBe('Caller owns this change');
        expect(await workflow.countExecutions()).toBe(0);
      } finally {
        validation.mockRestore();
        if (!transaction.finished) await transaction.rollback();
      }
    });

    it('sync on trigger class', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'syncTrigger',
      });

      const processor = await plugin.trigger(w1, {});

      const executions = await w1.getExecutions();
      expect(executions.length).toBe(1);
      expect(executions[0].status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(processor.execution.id).toBe(executions[0].id);
      expect(processor.execution.status).toBe(executions[0].status);
    });

    it('sync on workflow instance', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'asyncTrigger',
        sync: true,
      });

      const processor = await plugin.trigger(w1, {});

      const executions = await w1.getExecutions();
      expect(executions.length).toBe(1);
      expect(executions[0].status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(processor.execution.id).toBe(executions[0].id);
      expect(processor.execution.status).toBe(executions[0].status);
    });

    it('should persist legacy data visibility in tenant context', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'syncTrigger',
      });

      await plugin.trigger(
        w1,
        {},
        {
          context: {
            state: {
              currentTenant: { id: 'tenant-a', name: 'tenant-a' },
              currentTenantId: 'tenant-a',
              currentTenantDescendantIds: [],
              currentTenancyMode: 'tenantScoped',
              currentLegacyDataTenantIds: ['tenant-a'],
              workflowExcludeLegacyData: true,
            },
          },
        },
      );

      const [execution] = await w1.getExecutions();
      expect(execution.tenantContext).toMatchObject({
        currentTenantId: 'tenant-a',
        currentLegacyDataTenantIds: ['tenant-a'],
        workflowExcludeLegacyData: true,
      });
    });

    it('should extract tenant context from later state sources when an earlier state is empty', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'syncTrigger',
      });

      await plugin.trigger(
        w1,
        {
          state: {
            currentTenant: { id: 'payload-tenant' },
            currentTenantId: 'payload-tenant',
          },
        },
        {
          context: {
            state: {},
          },
          httpContext: {
            state: {
              currentTenant: { id: 'tenant-from-context' },
              currentTenantId: 'tenant-from-context',
              currentTenantDescendantIds: [],
              currentTenancyMode: 'tenantScoped',
            },
          },
        },
      );

      const [execution] = await w1.getExecutions();
      expect(execution.tenantId).toBe('tenant-from-context');
      expect(execution.tenantContext).toMatchObject({
        currentTenantId: 'tenant-from-context',
      });
    });

    it('should preserve numeric zero tenant id in execution tenant context', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'syncTrigger',
      });

      await plugin.trigger(
        w1,
        {},
        {
          context: {
            state: {
              currentTenant: { id: 0 },
              currentTenantId: 0,
              currentTenantDescendantIds: [],
              currentTenancyMode: 'tenantScoped',
            },
          },
        },
      );

      const [execution] = await w1.getExecutions();
      expect(execution.tenantId).toBe('0');
      expect(execution.tenantContext).toMatchObject({
        currentTenantId: 0,
      });
    });

    it('should not persist tenant context from event payload state', async () => {
      const w1 = await WorkflowModel.create({
        enabled: true,
        type: 'syncTrigger',
      });

      await plugin.trigger(w1, {
        state: {
          currentTenant: { id: 'payload-tenant' },
          currentTenantId: 'payload-tenant',
        },
      });

      const [execution] = await w1.getExecutions();
      expect(execution.tenantId).toBeNull();
      expect(execution.tenantContext).toBeNull();
    });
  });
});
