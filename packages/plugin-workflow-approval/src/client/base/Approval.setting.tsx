import { ColumnExecutedTime, ExecutionRetryAction, WorkflowPane } from '@tachybase/module-workflow/client';

import { tval } from '../locale';
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
      scope={{
        ExecutionRetryAction,
      }}
    />
  ),
  aclSnippet: 'pm.workflow.workflows',
  sort: -10,
};
