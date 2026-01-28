import { useCurrentUserContext } from '@tachybase/client';

import { useApproval, useResubmit } from '..';
import { APPROVAL_INITIATION_STATUS } from '../constants/approval-initiation-status';

export const ProviderActionResubmit = (props) => {
  const { data } = useCurrentUserContext();
  const { isResubmit } = useResubmit();
  const { status, createdById } = useApproval();

  const isSameId = data.data.id === createdById;
  const isDraft = status === APPROVAL_INITIATION_STATUS.DRAFT;
  const isReturned = status === APPROVAL_INITIATION_STATUS.RETURNED;
  if (isSameId && !isResubmit && !isDraft && !isReturned) {
    return props.children;
  }

  return null;
};
