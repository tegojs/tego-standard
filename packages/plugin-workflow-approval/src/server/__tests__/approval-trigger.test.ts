import { describe, expect, it, vi } from 'vitest';

import { APPROVAL_STATUS } from '../constants/status';
import ApprovalTrigger from '../triggers/Approval';

function createTriggerContext(
  options: {
    collectionSequelize?: unknown;
    trigger?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const fallbackTransaction = { id: 'fallback' };
  const repository = {
    findOne: vi.fn().mockResolvedValue({ id: 42 }),
  };
  const collection = {
    model: { sequelize: options.collectionSequelize },
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
    },
  };
  const approvalValues = {
    dataKey: 42,
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
