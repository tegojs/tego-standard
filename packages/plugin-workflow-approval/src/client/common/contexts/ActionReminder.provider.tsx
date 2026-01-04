import { useCurrentUserContext } from '@tachybase/client';

import { APPROVAL_INITIATION_STATUS } from '../constants/approval-initiation-status';
import { useApproval } from './ApprovalData.provider';
import { useContextApprovalExecution } from './approvalExecution';

export const ProviderActionReminder = (props) => {
  const { data } = useCurrentUserContext();

  const { status, createdById, latestExecutionId } = useApproval();
  const approvalExecution = useContextApprovalExecution();

  const isSameId = data.data.id === createdById;
  const isSameExecutionId = latestExecutionId === approvalExecution.id;
  const isDraft = status === APPROVAL_INITIATION_STATUS.DRAFT;
  const isReturned = status === APPROVAL_INITIATION_STATUS.RETURNED;
  const isApproved = status === APPROVAL_INITIATION_STATUS.APPROVED;

  if (isSameId && !isDraft && !isReturned && !isApproved && isSameExecutionId) {
    return props.children;
  }

  return null;
};
