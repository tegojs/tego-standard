import { useEffect, useMemo } from 'react';
import { useFormBlockContext } from '@tachybase/client';

import { useContexWorkflowNotice } from '../../user-interface/pc/common/notice-show-detail/contexts/WorkflowNotice.context';
import { resolveNoticeSnapshot } from '../tools/notice-snapshot';

export function usePropsNoticeDetail() {
  const { snapshot, execution, collectionName } = useContexWorkflowNotice();
  const { form } = useFormBlockContext();
  const values = useMemo(
    () => resolveNoticeSnapshot({ snapshot, collectionName }, execution?.context),
    [snapshot, execution?.context, collectionName],
  );

  useEffect(() => {
    form.setValues(values);
  }, [form, values]);

  return { form };
}
