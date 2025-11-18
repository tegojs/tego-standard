import {
  useActionContext,
  useCancelAction,
  useDataBlockRequest,
  useDataBlockResource,
  useFilterByTk,
} from '@tachybase/client';
import { ColumnExecutedTime, ExecutionRetryAction, WorkflowPane } from '@tachybase/module-workflow/client';
import { useForm } from '@tachybase/schema';

import { message } from 'antd';

import { tval, useTranslation } from '../locale';
import { schemaApprovalPanne } from './ApprovalPane.schema';
import { ColumnShowApprovalId } from './ColumnShowApprovalId';

export const systemSettingName = 'workflow-approval';

export const settingApproval = {
  title: tval('Approval flow'),
  icon: 'approval',
  Component: () => (
    <WorkflowPane
      schema={schemaApprovalPanne}
      components={{
        ColumnShowApprovalId,
        ColumnExecutedTime,
      }}
      scopes={{
        ExecutionRetryAction,
        useCancelAction,
        useRevisionAction,
      }}
    />
  ),
  aclSnippet: 'pm.workflow.workflows',
  sort: -10,
};

// 审批工作流复制的 useAction hook
function useRevisionAction() {
  const { t } = useTranslation();
  const { refresh } = useDataBlockRequest();
  const resource = useDataBlockResource();
  const { setVisible } = useActionContext();
  const filterByTk = useFilterByTk();
  const { values } = useForm();
  return {
    async run() {
      await resource.revision({ filterByTk, values });
      message.success(t('Operation succeeded'));
      refresh();
      setVisible(false);
    },
  };
}
