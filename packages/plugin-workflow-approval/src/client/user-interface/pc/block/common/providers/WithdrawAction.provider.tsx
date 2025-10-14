import { useCurrentUserContext } from '@tachybase/client';
import { useFlowContext } from '@tachybase/module-workflow/client';

import { APPROVAL_INITIATION_STATUS } from '../../../../../common/constants/approval-initiation-status';
import { useApproval } from '../../../common/ApprovalData.provider';
import { useResubmit } from '../../../common/Resubmit.provider';

// TODO: 也许可以抽成审批范围内通用的
export function WithdrawActionProvider({ children }) {
  const { data } = useCurrentUserContext();
  const { status, createdById } = useApproval();
  const { workflow } = useFlowContext();
  const { isResubmit } = useResubmit();

  const isSameId = data.data.id === createdById;
  // 旧版本的 workflow 的 enabled 字段是 false,但是实际运行过程里也允许撤回.所以这里不再检查 enabled 字段.
  const isEnabledWithdraw = workflow.config.withdrawable;
  const isStatusSubmitted = APPROVAL_INITIATION_STATUS.SUBMITTED === status;

  if (isSameId && isEnabledWithdraw && isStatusSubmitted && !isResubmit) {
    return children;
  }

  return null;
}
