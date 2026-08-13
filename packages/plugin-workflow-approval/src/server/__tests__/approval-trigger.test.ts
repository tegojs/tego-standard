import { Model } from '@tego/server';

import { describe, expect, it, vi } from 'vitest';

import { APPROVAL_STATUS } from '../constants/status';
import ApprovalTrigger from '../triggers/Approval';

class TriggerRecord {
  constructor(private readonly values: Record<string, any>) {
    Object.assign(this, values);
  }

  get(key: string) {
    return this.values[key];
  }
}

const brokenAssociationData = { id: 42, title: 'approval summary' };

class BrokenAssociationRecord extends Model {
  static associations = {};

  get(keyOrOptions?: string | { plain?: boolean }) {
    if (typeof keyOrOptions === 'string') {
      return brokenAssociationData[keyOrOptions];
    }
    if (keyOrOptions?.plain) {
      return brokenAssociationData;
    }
    throw new TypeError("Cannot read properties of undefined (reading 'length')");
  }
}

function createBrokenAssociationRecord() {
  const record = Object.create(BrokenAssociationRecord.prototype);
  record.dataValues = brokenAssociationData;
  return record;
}

function createTriggerHarness({
  rows,
  state = {},
  transaction,
  dataSourceTransaction = transaction,
  collectionModel = TriggerRecord,
  findOne = vi.fn(async ({ filterByTk }) => ({
    id: filterByTk,
    title: `summary-${filterByTk}`,
  })),
  approvalCreate = vi.fn(async () => undefined),
}: {
  rows: TriggerRecord | Model | Array<TriggerRecord | Model>;
  state?: Record<string, any>;
  transaction?: any;
  dataSourceTransaction?: any;
  collectionModel?: any;
  findOne?: ReturnType<typeof vi.fn>;
  approvalCreate?: ReturnType<typeof vi.fn>;
}) {
  const collection = {
    filterTargetKey: 'id',
    getField: vi.fn(() => undefined),
    model: collectionModel,
    repository: {
      findOne,
    },
  };
  const dataSource = {
    collectionManager: {
      getCollection: vi.fn(() => collection),
    },
  };
  const dataSourceManager = {
    dataSources: new Map([['main', dataSource]]),
  };
  const workflow = {
    id: 1,
    key: 'approval-key',
    type: 'approval',
    enabled: true,
    config: {
      collection: 'orders',
      appends: ['detail'],
      summary: ['title'],
    },
  };
  const workflowPlugin = {
    app: {
      dataSourceManager,
    },
    db: {
      getRepository: vi.fn((name) => {
        if (name === 'approvals') {
          return { create: approvalCreate };
        }
        throw new Error(`Unexpected repository ${name}`);
      }),
    },
    enabledCache: new Map([[workflow.id, workflow]]),
    useDataSourceTransaction: vi.fn(() => dataSourceTransaction),
  };
  const ctx = {
    app: {},
    body: rows,
    get: vi.fn((name: string) => (name === 'x-data-source' ? 'main' : '')),
    state,
    tego: {
      dataSourceManager,
    },
    transaction,
  };
  const trigger = Object.create(ApprovalTrigger.prototype) as ApprovalTrigger;
  (trigger as any).workflow = workflowPlugin;

  return {
    approvalCreate,
    ctx,
    dataSourceTransaction,
    findOne,
    trigger,
    workflowPlugin,
  };
}

describe('ApprovalTrigger.collectionTriggerAction', () => {
  it('fetches summary data for each bulk row by its own primary key', async () => {
    const transaction = { id: 'request-transaction' };
    const dataSourceTransaction = { id: 'data-source-transaction' };
    const rows = [new TriggerRecord({ id: 101, title: 'first' }), new TriggerRecord({ id: 102, title: 'second' })];
    const { approvalCreate, ctx, findOne, trigger, workflowPlugin } = createTriggerHarness({
      dataSourceTransaction,
      rows,
      state: { currentTenantId: 'tenant-a' },
      transaction,
    });

    await trigger.collectionTriggerAction(ctx, 'approval-key');

    expect(findOne).toHaveBeenCalledTimes(2);
    expect(findOne.mock.calls.map(([options]) => options.filterByTk)).toEqual([101, 102]);
    expect(findOne.mock.calls.map(([options]) => options.context)).toEqual([ctx, ctx]);
    expect(findOne.mock.calls.map(([options]) => options.transaction)).toEqual([
      dataSourceTransaction,
      dataSourceTransaction,
    ]);
    expect(workflowPlugin.useDataSourceTransaction).toHaveBeenCalledWith('main', transaction);

    expect(approvalCreate).toHaveBeenCalledTimes(2);
    expect(approvalCreate.mock.calls.map(([options]) => options.values.dataKey)).toEqual([101, 102]);
    expect(approvalCreate.mock.calls.map(([options]) => options.transaction)).toEqual([transaction, transaction]);
  });

  it('uses tenant context when fetching tenant-scoped summary data', async () => {
    const tenantFindOne = vi.fn(async ({ context }) => {
      if (context?.state?.currentTenantId === 'tenant-a') {
        return { id: 201, tenantId: 'tenant-a', title: 'tenant-a summary' };
      }

      return { id: 201, tenantId: 'tenant-b', title: 'tenant-b summary' };
    });
    const { approvalCreate, ctx, findOne, trigger } = createTriggerHarness({
      findOne: tenantFindOne,
      rows: new TriggerRecord({ id: 201, title: 'payload' }),
      state: {
        currentTenant: { id: 'tenant-a' },
        currentTenantId: 'tenant-a',
        currentTenancyMode: 'tenantScoped',
      },
    });

    await trigger.collectionTriggerAction(ctx, 'approval-key');

    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ context: ctx }));
    expect(approvalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({
          status: APPROVAL_STATUS.SUBMITTED,
          summary: [
            expect.objectContaining({
              key: 'title',
              value: 'tenant-a summary',
            }),
          ],
          tenantId: 'tenant-a',
        }),
      }),
    );
  });

  it('keeps non-tenant behavior when currentTenantId is absent', async () => {
    const { approvalCreate, ctx, findOne, trigger } = createTriggerHarness({
      rows: new TriggerRecord({ id: 301, title: 'payload' }),
      state: {},
    });

    await trigger.collectionTriggerAction(ctx, 'approval-key');

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        context: ctx,
        filterByTk: 301,
      }),
    );
    expect(approvalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        context: ctx,
        values: expect.not.objectContaining({
          tenantId: expect.anything(),
        }),
      }),
    );
    expect(approvalCreate.mock.calls[0][0].values.summary).toEqual([
      expect.objectContaining({
        key: 'title',
        value: 'summary-301',
      }),
    ]);
  });

  it('waits for approval creation before resolving', async () => {
    let resolveCreate: () => void;
    const createPromise = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const approvalCreate = vi.fn(() => createPromise);
    const { trigger, ctx } = createTriggerHarness({
      approvalCreate,
      rows: new TriggerRecord({ id: 401, title: 'payload' }),
    });

    const actionPromise = trigger.collectionTriggerAction(ctx, 'approval-key');
    await Promise.resolve();
    await Promise.resolve();

    expect(approvalCreate).toHaveBeenCalledTimes(1);

    let settled = false;
    actionPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);

    resolveCreate!();
    await actionPromise;

    expect(settled).toBe(true);
  });

  it('uses plain persisted data when a collection-triggered record cannot be serialized through get()', async () => {
    const record = createBrokenAssociationRecord();
    const { approvalCreate, ctx, trigger } = createTriggerHarness({
      collectionModel: BrokenAssociationRecord,
      rows: record,
    });

    await trigger.collectionTriggerAction(ctx, 'approval-key');

    expect(approvalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ data: brokenAssociationData }),
      }),
    );
  });
});

describe('ApprovalTrigger.workflowTriggerAction', () => {
  it('uses plain persisted data when a directly triggered record cannot be serialized through get()', async () => {
    const record = createBrokenAssociationRecord();
    const approvalCreate = vi.fn();
    const workflow = {
      id: 1,
      key: 'approval-key',
      config: { collection: 'orders', summary: [] },
    };
    const collection = {
      filterTargetKey: 'id',
      getField: vi.fn(() => undefined),
      repository: { create: vi.fn().mockResolvedValue(record) },
    };
    const workflowPlugin = {
      app: {
        dataSourceManager: {
          dataSources: new Map([['main', { collectionManager: { getCollection: vi.fn(() => collection) } }]]),
        },
      },
      db: {
        getRepository: vi.fn((name: string) => {
          if (name === 'workflows') {
            return { find: vi.fn().mockResolvedValue([workflow]) };
          }
          if (name === 'approvals') {
            return { create: approvalCreate };
          }
          throw new Error(`Unexpected repository ${name}`);
        }),
      },
    };
    const trigger = Object.create(ApprovalTrigger.prototype) as ApprovalTrigger;
    (trigger as any).workflow = workflowPlugin;
    const ctx = {
      action: { params: { triggerWorkflows: 'approval-key', values: { title: 'request' } } },
      state: {},
      status: 0,
      throw(status: number) {
        throw Object.assign(new Error(String(status)), { status });
      },
    };

    await trigger.workflowTriggerAction(ctx, vi.fn());
    await vi.waitFor(() => expect(approvalCreate).toHaveBeenCalledOnce());

    expect(approvalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ data: brokenAssociationData }),
      }),
    );
  });
});

function createTriggerContext(
  options: {
    collectionSequelize?: unknown;
    trigger?: ReturnType<typeof vi.fn>;
    tenantContext?: Record<string, any>;
    tenantId?: string;
    workflowConfig?: Record<string, any>;
    collectionFields?: Record<string, any>;
    collectionAssociations?: Record<string, any>;
    targetCollections?: Record<string, any>;
  } = {},
) {
  const fallbackTransaction = { id: 'fallback' };
  const repository = {
    findOne: vi.fn().mockResolvedValue({ id: 42 }),
  };
  const collection = {
    model: { sequelize: options.collectionSequelize, associations: options.collectionAssociations ?? {} },
    getField: vi.fn((name: string) => options.collectionFields?.[name]),
    db: { getCollection: vi.fn((name: string) => options.targetCollections?.[name]) },
    repository,
  };
  const useDataSourceTransaction = vi.fn().mockReturnValue(fallbackTransaction);
  const loggerError = vi.fn();
  const workflowPlugin = {
    app: {
      db: { on: vi.fn() },
      dataSourceManager: {
        dataSources: {
          get: vi.fn().mockReturnValue({
            collectionManager: {
              getCollection: vi.fn().mockReturnValue(collection),
            },
          }),
        },
      },
      logger: { error: loggerError },
      use: vi.fn(),
    },
    trigger: options.trigger ?? vi.fn(),
    useDataSourceTransaction,
  };
  const trigger = new ApprovalTrigger(workflowPlugin as any);
  const workflow = {
    config: {
      appends: [],
      collection: 'orders',
      summary: [],
      ...options.workflowConfig,
    },
  };
  const approvalValues = {
    dataKey: 42,
    tenantContext: options.tenantContext,
    tenantId: options.tenantId,
    workflowId: 1,
    workflowKey: 'approval-workflow',
  };
  const approval = {
    applicantRoleName: 'root',
    changed: vi.fn().mockReturnValue(true),
    collectionName: 'orders',
    get: vi.fn((key: string) => approvalValues[key]),
    getWorkflow: vi.fn().mockResolvedValue(workflow),
    id: 7,
    previous: vi.fn().mockReturnValue(APPROVAL_STATUS.DRAFT),
    status: APPROVAL_STATUS.SUBMITTED,
  };

  return {
    approval,
    fallbackTransaction,
    loggerError,
    repository,
    trigger,
    useDataSourceTransaction,
  };
}

describe('ApprovalTrigger', () => {
  it('uses plain persisted data when a workflow record cannot be serialized through get()', async () => {
    const record = createBrokenAssociationRecord();
    const triggerWorkflow = vi.fn();
    const { approval, repository, trigger } = createTriggerContext({ trigger: triggerWorkflow });
    repository.findOne.mockResolvedValue(record);

    await trigger.triggerHandler(approval);

    await vi.waitFor(() => {
      expect(triggerWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ data: brokenAssociationData }),
        expect.anything(),
      );
    });
  });

  it('uses the workflow transaction when no data source transaction is provided', async () => {
    const context = createTriggerContext();
    const { approval, fallbackTransaction, repository } = context;
    const { trigger, useDataSourceTransaction } = context;

    await trigger.triggerHandler(approval);

    expect(useDataSourceTransaction).toHaveBeenCalledWith('main', undefined);
    const expectedTransaction = expect.objectContaining({ transaction: fallbackTransaction });
    expect(repository.findOne).toHaveBeenCalledWith(expectedTransaction);
  });

  it('uses a matching data source transaction directly', async () => {
    const sequelize = {};
    const dataSourceTransaction = { sequelize };
    const { approval, repository, trigger, useDataSourceTransaction } = createTriggerContext({
      collectionSequelize: sequelize,
    });

    await trigger.triggerHandler(approval, { dataSourceTransaction } as any);

    const expectedTransaction = expect.objectContaining({ transaction: dataSourceTransaction });
    expect(repository.findOne).toHaveBeenCalledWith(expectedTransaction);
    expect(useDataSourceTransaction).not.toHaveBeenCalled();
  });

  it('defers the workflow trigger through deferAfterCommit when provided', async () => {
    const triggerWorkflow = vi.fn();
    const deferAfterCommit = vi.fn();
    const { approval, trigger } = createTriggerContext({ trigger: triggerWorkflow });

    await trigger.triggerHandler(approval, { deferAfterCommit });

    expect(deferAfterCommit).toHaveBeenCalledWith(expect.any(Function));
    expect(triggerWorkflow).not.toHaveBeenCalled();
  });

  it('passes the approval tenant context to the workflow execution', async () => {
    const triggerWorkflow = vi.fn();
    const { approval, trigger } = createTriggerContext({
      tenantContext: {
        currentTenantDescendantIds: ['tenant-child'],
        currentTenancyMode: 'tenantScoped',
      },
      tenantId: 'tenant-a',
      trigger: triggerWorkflow,
    });

    await trigger.triggerHandler(approval);

    await vi.waitFor(() => {
      expect(triggerWorkflow).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          context: {
            state: {
              currentTenant: { id: 'tenant-a' },
              currentTenantDescendantIds: ['tenant-child'],
              currentTenantId: 'tenant-a',
              currentTenancyMode: 'tenantScoped',
              currentLegacyDataTenantIds: [],
            },
          },
        }),
      );
    });
  });

  it('filters stale nested association appends on the approval submission path', async () => {
    const positions = {
      getField: vi.fn((name: string) => (name === 'positionName' ? { type: 'string' } : undefined)),
    };
    const users = {
      getField: vi.fn((name: string) =>
        name === 'positions' ? { type: 'belongsToMany', target: 'positions' } : undefined,
      ),
      db: { getCollection: vi.fn(() => positions) },
      model: { associations: {} },
    };
    const triggerWorkflow = vi.fn();
    const { approval, repository, trigger } = createTriggerContext({
      trigger: triggerWorkflow,
      collectionFields: { owner: { type: 'belongsTo', target: 'users' } },
      collectionAssociations: { owner: {} },
      targetCollections: { users },
      workflowConfig: { appends: ['owner.positions', 'owner'], summary: [] },
    });

    await trigger.triggerHandler(approval);

    expect(repository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        appends: ['owner'],
      }),
    );
  });

  it('wraps transaction commit and triggers the workflow after a successful commit', async () => {
    const triggerWorkflow = vi.fn();
    const { approval, trigger } = createTriggerContext({ trigger: triggerWorkflow });
    const transaction = {
      commit: vi.fn().mockResolvedValue(undefined),
    };
    const originalCommit = transaction.commit;

    await trigger.triggerHandler(approval, { transaction } as any);

    expect(transaction.commit).not.toBe(originalCommit);
    expect(triggerWorkflow).not.toHaveBeenCalled();

    await transaction.commit();

    expect(originalCommit).toHaveBeenCalledOnce();
    expect(triggerWorkflow).toHaveBeenCalledOnce();
  });

  it('logs workflow trigger rejection when no transaction is available', async () => {
    const triggerError = new Error('trigger failed');
    const triggerWorkflow = vi.fn().mockRejectedValue(triggerError);
    const { approval, loggerError, trigger } = createTriggerContext({ trigger: triggerWorkflow });
    const expectedMessage = 'Approval workflow trigger failed after transaction commit';

    await trigger.triggerHandler(approval);

    await vi.waitFor(() => {
      expect(loggerError).toHaveBeenCalledWith(expectedMessage, {
        approvalId: 7,
        collectionName: 'orders',
        error: {
          name: 'Error',
          message: 'trigger failed',
          stack: expect.any(String),
        },
      });
    });
  });
});
