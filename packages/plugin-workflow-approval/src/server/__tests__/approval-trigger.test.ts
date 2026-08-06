import { describe, expect, it, vi } from 'vitest';

import { APPROVAL_STATUS } from '../constants/status';
import ApprovalTrigger from '../triggers/Approval';

describe('ApprovalTrigger', () => {
  it('uses the workflow transaction when no data source transaction is provided', async () => {
    const fallbackTransaction = { id: 'fallback' };
    const repository = {
      findOne: vi.fn().mockResolvedValue({ id: 42 }),
    };
    const collection = {
      model: { sequelize: undefined },
      repository,
    };
    const useDataSourceTransaction = vi.fn().mockReturnValue(fallbackTransaction);
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
        use: vi.fn(),
      },
      trigger: vi.fn(),
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

    await trigger.triggerHandler(approval);

    expect(useDataSourceTransaction).toHaveBeenCalledWith('main', undefined);
    expect(repository.findOne).toHaveBeenCalledWith(expect.objectContaining({ transaction: fallbackTransaction }));
  });
});
