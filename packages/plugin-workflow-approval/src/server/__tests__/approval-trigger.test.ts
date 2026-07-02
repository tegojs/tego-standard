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

function createTriggerHarness({
  rows,
  state = {},
  transaction,
  dataSourceTransaction = transaction,
  findOne = vi.fn(async ({ filterByTk }) => ({
    id: filterByTk,
    title: `summary-${filterByTk}`,
  })),
  approvalCreate = vi.fn(async () => undefined),
}: {
  rows: TriggerRecord | TriggerRecord[];
  state?: Record<string, any>;
  transaction?: any;
  dataSourceTransaction?: any;
  findOne?: ReturnType<typeof vi.fn>;
  approvalCreate?: ReturnType<typeof vi.fn>;
}) {
  const collection = {
    filterTargetKey: 'id',
    getField: vi.fn(() => undefined),
    model: TriggerRecord,
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
});
