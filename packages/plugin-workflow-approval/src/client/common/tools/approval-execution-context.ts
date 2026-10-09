import { APPROVAL_TODO_STATUS } from '../constants/approval-todo-status';

interface ApprovalExecutionContextOptions {
  approval?: any;
  approvalExecution?: any;
  execution?: any;
  recordStatus?: number | null;
}

export function resolveApprovalExecutionContext({
  approval,
  approvalExecution,
  execution,
  recordStatus,
}: ApprovalExecutionContextOptions) {
  if (execution) {
    return execution;
  }

  const isCompletedRecord = recordStatus != null && recordStatus !== APPROVAL_TODO_STATUS.PENDING;
  if (!isCompletedRecord || approvalExecution?.snapshot == null) {
    return undefined;
  }

  return {
    id: approvalExecution.executionId,
    status: approvalExecution.status,
    jobs: [],
    context: {
      approvalId: approval?.id,
      collectionName: approvalExecution.collectionName ?? approval?.collectionName,
      data: approvalExecution.snapshot,
    },
    archived: true,
  };
}
