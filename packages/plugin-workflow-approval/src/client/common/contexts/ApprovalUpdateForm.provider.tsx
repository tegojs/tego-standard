import { useContextApprovalExecution, useContextApprovalRecords } from '..';
import { APPROVAL_TODO_STATUS } from '../constants/approval-todo-status';

export const ProviderApprovalUpdateForm = (props) => {
  // TODO: 临时修复, 重构过程中将同类上下文合并
  const { status } = useContextApprovalRecords();
  const { status: statusMobile } = useContextApprovalExecution();
  if (status === APPROVAL_TODO_STATUS.PENDING || statusMobile === APPROVAL_TODO_STATUS.PENDING) {
    return props.children;
  } else {
    return null;
  }
};
