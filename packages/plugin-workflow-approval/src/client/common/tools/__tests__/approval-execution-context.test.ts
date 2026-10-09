import { APPROVAL_TODO_STATUS } from '../../constants/approval-todo-status';
import { resolveApprovalExecutionContext, resolveArchivedExecutionContext } from '../approval-execution-context';

describe('approval execution detail context', () => {
  it('keeps a live workflow execution unchanged', () => {
    const execution = { id: 10, context: { data: { id: 1 } }, jobs: [] };

    expect(
      resolveApprovalExecutionContext({
        execution,
        recordStatus: APPROVAL_TODO_STATUS.APPROVED,
      }),
    ).toBe(execution);
  });

  it('restores read-only detail context for a completed approval whose workflow execution was deleted', () => {
    const snapshot = { id: 67193, amount: 2000 };

    expect(
      resolveApprovalExecutionContext({
        approval: { id: 2523, collectionName: 'receipts' },
        approvalExecution: {
          id: 4046,
          executionId: 1471894,
          collectionName: 'receipts',
          snapshot,
          status: 1,
        },
        recordStatus: APPROVAL_TODO_STATUS.APPROVED,
      }),
    ).toEqual({
      id: 1471894,
      status: 1,
      jobs: [],
      context: {
        approvalId: 2523,
        collectionName: 'receipts',
        data: snapshot,
      },
      archived: true,
    });
  });

  it('does not restore an actionable approval task without its workflow execution', () => {
    expect(
      resolveApprovalExecutionContext({
        approval: { id: 2934, collectionName: 'receipts' },
        approvalExecution: { executionId: 1472000, snapshot: { id: 70589 } },
        recordStatus: APPROVAL_TODO_STATUS.PENDING,
      }),
    ).toBeUndefined();
  });

  it('does not restore detail context without an approval execution snapshot', () => {
    expect(
      resolveApprovalExecutionContext({
        approval: { id: 2523, collectionName: 'receipts' },
        recordStatus: APPROVAL_TODO_STATUS.APPROVED,
      }),
    ).toBeUndefined();
  });

  it('restores read-only detail context for a carbon copy whose workflow execution was deleted', () => {
    const snapshot = { id: 70910, reason: 'Approved payment' };

    expect(
      resolveArchivedExecutionContext({
        executionId: 1486541,
        collectionName: 'receipt',
        snapshot,
        allowSnapshotWithoutStatus: true,
      }),
    ).toEqual({
      id: 1486541,
      jobs: [],
      context: {
        collectionName: 'receipt',
        data: snapshot,
      },
      archived: true,
    });
  });
});
