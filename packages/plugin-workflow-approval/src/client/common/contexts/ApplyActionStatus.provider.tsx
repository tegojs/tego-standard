import { useCurrentUserContext } from '@tachybase/client';

import { useApproval, useResubmit } from '..';
import { APPROVAL_INITIATION_STATUS } from '../constants/approval-initiation-status';
import { ProviderContextApprovalStatus } from './ApprovalStatus.context';

export const ProviderApplyActionStatus = (props) => {
  const { value, children } = props;
  const { status, createdById } = useApproval();
  const { data } = useCurrentUserContext();
  const { isResubmit } = useResubmit();
  const isSameId = data.data.id === createdById;
  const isStatusDid = [
    APPROVAL_INITIATION_STATUS.RESUBMIT,
    APPROVAL_INITIATION_STATUS.DRAFT,
    APPROVAL_INITIATION_STATUS.RETURNED,
  ].includes(status);

  if (value === APPROVAL_INITIATION_STATUS.DRAFT && status === APPROVAL_INITIATION_STATUS.DRAFT) {
    return null;
  }

  if (isSameId && (isStatusDid || isResubmit)) {
    return <ProviderContextApprovalStatus value={value}>{children}</ProviderContextApprovalStatus>;
  }

  return null;
};
