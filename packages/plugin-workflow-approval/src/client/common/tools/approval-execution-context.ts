import { APPROVAL_TODO_STATUS } from '../constants/approval-todo-status';

interface ApprovalExecutionContextOptions {
  approval?: any;
  approvalExecution?: any;
  execution?: any;
  recordStatus?: number | null;
}

interface ArchivedExecutionContextOptions {
  execution?: any;
  executionId?: number;
  collectionName?: string;
  snapshot?: any;
  approvalId?: number;
  status?: number;
  recordStatus?: number | null;
  allowSnapshotWithoutStatus?: boolean;
}

export function resolveApprovalExecutionContext({
  approval,
  approvalExecution,
  execution,
  recordStatus,
}: ApprovalExecutionContextOptions) {
  return resolveArchivedExecutionContext({
    execution,
    executionId: approvalExecution?.executionId,
    collectionName: approvalExecution?.collectionName ?? approval?.collectionName,
    snapshot: approvalExecution?.snapshot,
    approvalId: approval?.id,
    status: approvalExecution?.status,
    recordStatus,
  });
}

export function resolveArchivedExecutionContext({
  execution,
  executionId,
  collectionName,
  snapshot,
  approvalId,
  status,
  recordStatus,
  allowSnapshotWithoutStatus = false,
}: ArchivedExecutionContextOptions) {
  if (execution) {
    return execution;
  }

  const isCompletedRecord = recordStatus != null && recordStatus !== APPROVAL_TODO_STATUS.PENDING;
  if ((!isCompletedRecord && !allowSnapshotWithoutStatus) || snapshot == null) {
    return undefined;
  }

  return {
    id: executionId,
    ...(status == null ? {} : { status }),
    jobs: [],
    context: {
      ...(approvalId == null ? {} : { approvalId }),
      collectionName,
      data: snapshot,
    },
    archived: true,
  };
}
