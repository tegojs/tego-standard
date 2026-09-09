import { getApp } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import * as executionActions from '../../actions/executions';
import * as workflowActions from '../../actions/workflows';
import executionsCollection from '../../collections/executions';
import { EXECUTION_STATUS } from '../../constants';
import { triggerWorkflowAndGetExecution } from '../../utils';
import { waitForWorkflowIdle } from '../utils';

describe('workflow > actions > tenant executions boundary', () => {
  let app: MockServer;
  let db: Database;
  let WorkflowModel;
  let plugin: any;

  beforeAll(async () => {
    app = await getApp();
    db = app.db;
    WorkflowModel = db.getCollection('workflows').model;
    plugin = app.pm.get('workflow') as any;
  });

  beforeEach(async () => {
    plugin.ready = true;
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
    await db.getRepository('jobs').destroy({ filter: {} });
    await db.getRepository('executions').destroy({ filter: {} });
    await db.getRepository('workflows').destroy({ filter: {} });
  });

  afterEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
  });

  afterAll(() => app.destroy());

  function tenantState(tenantId: string | number, legacyDataTenantIds: string[] = []) {
    return {
      currentTenant: { id: tenantId, name: tenantId },
      currentTenantId: tenantId,
      currentTenantDescendantIds: [],
      currentTenancyMode: 'tenantScoped',
      currentLegacyDataTenantIds: legacyDataTenantIds,
    };
  }

  function createContext(
    resourceName: string,
    actionName: string,
    params: any,
    tenantId: string,
    legacyDataTenantIds: string[] = [],
  ) {
    return {
      app,
      db,
      tego: {
        getPlugin: () => plugin,
        logger: app.logger,
        pm: {
          get: () => plugin,
        },
      },
      state: tenantState(tenantId, legacyDataTenantIds),
      transaction: undefined,
      t: (message: string) => message,
      action: {
        resourceName,
        actionName,
        params,
        mergeParams(nextParams: any) {
          this.params = {
            ...this.params,
            ...nextParams,
          };
        },
      },
      throw(status: number, message?: string) {
        const error = new Error(message || `${status}`) as Error & { status?: number };
        error.status = status;
        throw error;
      },
    } as any;
  }

  async function createWorkflow() {
    return WorkflowModel.create({
      enabled: true,
      type: 'syncTrigger',
    });
  }

  it('declares executions as tenant scoped for standard resource actions', () => {
    expect(executionsCollection.tenancy).toBe('tenantScoped');
  });

  describe('context-backed execution tenant field', () => {
    beforeEach(() => {
      db.getCollection('executions').setField('tenantId', {
        type: 'context',
        dataIndex: 'state.currentTenant.id',
        createOnly: true,
      });
    });

    afterEach(async () => {
      await waitForWorkflowIdle(app);
      db.getCollection('executions').setField('tenantId', { type: 'string' });
    });

    it.each([
      { sync: false, idOnly: false },
      { sync: false, idOnly: true },
      { sync: true, idOnly: false },
      { sync: true, idOnly: true },
    ])('test action returns its persisted execution: sync=$sync, idOnly=$idOnly', async ({ sync, idOnly }) => {
      const workflow = await WorkflowModel.create({ enabled: true, type: 'asyncTrigger', sync });
      await workflow.createNode({ type: 'echo' });
      const ctx = createContext(
        'workflows',
        'test',
        { filterByTk: workflow.id, values: { data: { tenantId: 'untrusted-tenant', marker: 'test-action' } } },
        'tenant-a',
      );
      if (idOnly) {
        delete ctx.state.currentTenant;
      }

      await workflowActions.test(ctx, async () => {});
      await waitForWorkflowIdle(app);

      const [execution] = await workflow.getExecutions();
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(execution.tenantId).toBe('tenant-a');
      expect(execution.tenantContext.currentTenantId).toBe('tenant-a');
      expect(ctx.body.id).toBe(execution.id);
      expect(ctx.body.tenantId).toBe('tenant-a');
      expect(execution.context.data.marker).toBe('test-action');
    });
  });

  it('workflows.retry should use the latest execution from the current tenant only', async () => {
    const workflow = await createWorkflow();
    await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.RESOLVED,
      context: { marker: 'tenant-a' },
      tenantId: 'tenant-a',
      tenantContext: tenantState('tenant-a'),
      createdAt: new Date(Date.now() - 1000),
    });
    await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.RESOLVED,
      context: { marker: 'tenant-b' },
      tenantId: 'tenant-b',
      tenantContext: tenantState('tenant-b'),
      createdAt: new Date(),
    });

    const ctx = createContext(
      'workflows',
      'retry',
      {
        filterByTk: workflow.id,
        filter: { key: workflow.key },
      },
      'tenant-a',
    );

    await workflowActions.retry(ctx, async () => {});

    expect(ctx.body.context.marker).toBe('tenant-a');
    expect(ctx.body.tenantId).toBe('tenant-a');
  });

  it('workflows.retry should fail closed when tenant context is missing', async () => {
    const workflow = await createWorkflow();
    await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.RESOLVED,
      context: { marker: 'tenant-b' },
      tenantId: 'tenant-b',
      tenantContext: tenantState('tenant-b'),
    });

    const ctx = createContext(
      'workflows',
      'retry',
      {
        filterByTk: workflow.id,
        filter: { key: workflow.key },
      },
      'tenant-a',
    );
    ctx.state = {};

    await expect(workflowActions.retry(ctx, async () => {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it('workflows.retry should not add tenant filter when tenant boundary is unavailable', async () => {
    const workflow = await createWorkflow();
    await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.RESOLVED,
      context: { marker: 'non-tenant' },
      tenantId: null,
      tenantContext: null,
    });

    const ctx = createContext(
      'workflows',
      'retry',
      {
        filterByTk: workflow.id,
        filter: { key: workflow.key },
      },
      'tenant-a',
    );
    ctx.state = {};
    ctx.tego.pm.get = (name: any) => (name === 'tenant' ? undefined : plugin);
    ctx.app.pm.get = (name: any) => (name === 'tenant' ? undefined : plugin);

    await workflowActions.retry(ctx, async () => {});

    expect(ctx.body.context.marker).toBe('non-tenant');
  });

  it('executions.retry should reject executions from another tenant', async () => {
    const workflow = await createWorkflow();
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.ERROR,
      context: { marker: 'tenant-b' },
      tenantId: 'tenant-b',
      tenantContext: tenantState('tenant-b'),
    });

    const ctx = createContext('executions', 'retry', { filterByTk: execution.id }, 'tenant-a');

    await expect(executionActions.retry(ctx, async () => {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it('executions.retry should fail closed when tenant context is missing', async () => {
    const workflow = await createWorkflow();
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.ERROR,
      context: { marker: 'tenant-b' },
      tenantId: 'tenant-b',
      tenantContext: tenantState('tenant-b'),
    });

    const ctx = createContext('executions', 'retry', { filterByTk: execution.id }, 'tenant-a');
    ctx.state = {};

    await expect(executionActions.retry(ctx, async () => {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it('executions.retry should reject a legacy execution retried from a different tenant context', async () => {
    const workflow = await createWorkflow();
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.ERROR,
      context: { marker: 'legacy-tenant-a' },
      tenantId: null,
      tenantContext: tenantState('tenant-a'),
    });

    const ctx = createContext('executions', 'retry', { filterByTk: execution.id }, 'tenant-b', ['tenant-b']);

    let error: Error & { status?: number };
    try {
      await executionActions.retry(ctx, async () => {});
    } catch (caught) {
      error = caught as Error & { status?: number };
    }

    expect(error).toBeDefined();
    expect(error.status).toBe(409);
    expect(error.stack.split('\n')[0]).toBe(
      `Error: Workflow retry was blocked before execution: execution ${execution.id} was created under tenant "tenant-a", but the current tenant is "tenant-b". Retry it from the original tenant.`,
    );
    expect(error.stack).toContain('TENANT_RETRY_CONTEXT_MISMATCH');
    expect(error.stack).toContain(`"executionId":${execution.id}`);
    expect(error.stack).toContain('"originalTenantId":"tenant-a"');
    expect(error.stack).toContain('"currentTenantId":"tenant-b"');
    expect(await workflow.countExecutions()).toBe(1);
  });

  it('executions.retry should reject a legacy execution whose original tenant context is unavailable', async () => {
    const workflow = await createWorkflow();
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.ERROR,
      context: { marker: 'legacy-without-tenant-context' },
      tenantId: null,
      tenantContext: null,
    });

    const ctx = createContext('executions', 'retry', { filterByTk: execution.id }, 'tenant-b', ['tenant-b']);

    let error: Error & { status?: number };
    try {
      await executionActions.retry(ctx, async () => {});
    } catch (caught) {
      error = caught as Error & { status?: number };
    }

    expect(error).toBeDefined();
    expect(error.status).toBe(409);
    expect(error.stack.split('\n')[0]).toBe(
      `Error: Workflow retry was blocked before execution: execution ${execution.id} has no saved tenant context, so its tenant cannot be determined safely. Start a new execution or restore the original tenant context before retrying.`,
    );
    expect(error.stack).toContain('TENANT_RETRY_CONTEXT_UNAVAILABLE');
    expect(error.stack).toContain(`"executionId":${execution.id}`);
    expect(error.stack).toContain('"executionTenantId":null');
    expect(error.stack).toContain('"currentTenantId":"tenant-b"');
    expect(await workflow.countExecutions()).toBe(1);
  });

  it('executions.destroy should fail closed when tenant mode exists but tenant context is missing', async () => {
    const workflow = await createWorkflow();
    await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.RESOLVED,
      context: { marker: 'tenant-b' },
      tenantId: 'tenant-b',
      tenantContext: tenantState('tenant-b'),
    });

    const ctx = createContext(
      'executions',
      'destroy',
      {
        filter: {
          key: workflow.key,
        },
      },
      'tenant-a',
    );
    ctx.state = {
      currentTenancyMode: 'tenantScoped',
    };

    await executionActions.destroy(ctx, async () => {});

    const executions = await workflow.getExecutions();
    expect(executions).toHaveLength(1);
  });

  it('executions.cancel should reject executions from another tenant', async () => {
    const workflow = await createWorkflow();
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.STARTED,
      context: { marker: 'tenant-b' },
      tenantId: 'tenant-b',
      tenantContext: tenantState('tenant-b'),
    });

    const ctx = createContext('executions', 'cancel', { filterByTk: execution.id }, 'tenant-a');

    await expect(executionActions.cancel(ctx, async () => {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it('executions.cancel should allow legacy executions when current tenant can read legacy data', async () => {
    const workflow = await createWorkflow();
    const execution = await workflow.createExecution({
      key: workflow.key,
      status: EXECUTION_STATUS.STARTED,
      context: { marker: 'legacy' },
      tenantId: null,
      tenantContext: null,
    });

    const ctx = createContext('executions', 'cancel', { filterByTk: execution.id }, 'tenant-a', ['tenant-a']);

    await executionActions.cancel(ctx, async () => {});
    await execution.reload();

    expect(execution.status).toBe(EXECUTION_STATUS.CANCELED);
  });

  it('triggerWorkflowAndGetExecution should poll queued executions in the current tenant only', async () => {
    let capturedFilter: any;
    const execution = { id: 1 };
    const dbMock = {
      getRepository: () => ({
        async findOne(options: any) {
          capturedFilter = options.filter;
          return execution;
        },
      }),
    };
    const pluginMock = {
      isWorkflowSync: () => false,
      trigger: async () => undefined,
    };

    const result = await triggerWorkflowAndGetExecution(
      pluginMock as any,
      { key: 'workflow-key' } as any,
      { state: tenantState('tenant-a') },
      {},
      dbMock as any,
    );

    expect(result).toBe(execution);
    expect(capturedFilter).toMatchObject({
      key: 'workflow-key',
      tenantId: 'tenant-a',
    });
  });

  it('triggerWorkflowAndGetExecution should preserve numeric zero tenant id when polling queued executions', async () => {
    let capturedFilter: any;
    const execution = { id: 1 };
    const dbMock = {
      getRepository: () => ({
        async findOne(options: any) {
          capturedFilter = options.filter;
          return execution;
        },
      }),
    };
    const pluginMock = {
      isWorkflowSync: () => false,
      trigger: async () => undefined,
    };

    const result = await triggerWorkflowAndGetExecution(
      pluginMock as any,
      { key: 'workflow-key' } as any,
      { state: tenantState(0) },
      {},
      dbMock as any,
    );

    expect(result).toBe(execution);
    expect(capturedFilter).toMatchObject({
      key: 'workflow-key',
      tenantId: 0,
    });
  });
});
