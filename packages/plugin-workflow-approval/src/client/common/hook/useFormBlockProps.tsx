import { useEffect } from 'react';
import { useCurrentUserContext } from '@tachybase/client';
import { useForm } from '@tachybase/schema';

import { approvalInitiationStatusMap } from '../constants/approval-initiation-status-options';
import { useApproval, useContextApprovalExecution, useResubmit } from '../contexts';

export function useFormBlockProps() {
  const approval = useApproval() as any;
  const approvalExecution = useContextApprovalExecution();
  const form = useForm();
  const { data } = useCurrentUserContext();
  const { isResubmit } = useResubmit();

  const { editable } = approvalInitiationStatusMap[approval.status];

  const needEditable =
    (isResubmit || editable) &&
    approval?.latestExecutionId === approvalExecution.id &&
    approval?.createdById === data?.data.id;

  useEffect(() => {
    if (!approval) {
      return;
    }

    if (needEditable) {
      form.setPattern('editable');
    } else {
      form.setPattern('readPretty');
    }
    if (isResubmit && approval.id) {
      const formValue = { ...approvalExecution?.snapshot, ...approval.data };
      form.setValues(formValue);
      form.setPattern('editable');
    }
  }, [form, approval, needEditable]);

  return { form };
}
