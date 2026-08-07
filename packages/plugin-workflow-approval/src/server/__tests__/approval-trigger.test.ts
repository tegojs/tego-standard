import { describe, expect, it, vi } from 'vitest';

import { APPROVAL_STATUS } from '../constants/status';
import ApprovalTrigger from '../triggers/Approval';

function createTriggerContext(options: { collectionSequelize?: unknown; trigger?: ReturnType<typeof vi.fn> } = {}) {
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

  return { approval, fallbackTransaction, loggerError, repository, trigger, useDataSourceTransaction };
}

describe('ApprovalTrigger', () => {
  it('uses the workflow transaction when no data source transaction is provided', async () => {
    const { approval, fallbackTransaction, repository, trigger, useDataSourceTransaction } = createTriggerContext();

    await trigger.triggerHandler(approval);

    expect(useDataSourceTransaction).toHaveBeenCalledWith('main', undefined);
    expect(repository.findOne).toHaveBeenCalledWith(expect.objectContaining({ transaction: fallbackTransaction }));
  });

  it('uses a matching data source transaction directly', async () => {
    const sequelize = {};
    const dataSourceTransaction = { sequelize };
    const { approval, repository, trigger, useDataSourceTransaction } = createTriggerContext({
      collectionSequelize: sequelize,
    });

    await trigger.triggerHandler(approval, { dataSourceTransaction } as any);

    expect(repository.findOne).toHaveBeenCalledWith(expect.objectContaining({ transaction: dataSourceTransaction }));
    expect(useDataSourceTransaction).not.toHaveBeenCalled();
  });

  it('logs workflow trigger rejection when no transaction is available', async () => {
    const triggerError = new Error('trigger failed');
    const triggerWorkflow = vi.fn().mockRejectedValue(triggerError);
    const { approval, loggerError, trigger } = createTriggerContext({ trigger: triggerWorkflow });

    await trigger.triggerHandler(approval);

    await vi.waitFor(() => {
      expect(loggerError).toHaveBeenCalledWith('Approval workflow trigger failed after transaction commit', {
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
