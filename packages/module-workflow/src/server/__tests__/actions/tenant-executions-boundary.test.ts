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

  function tenantState(tenantId: string, legacyDataTenantIds: string[] = []) {
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
});
