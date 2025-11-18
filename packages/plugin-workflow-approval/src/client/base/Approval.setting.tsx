import { useCancelAction } from '@tachybase/client';
import {
  ColumnExecutedTime,
  ExecutionRetryAction,
  useDumpAction,
  useRevisionAction,
  WorkflowPane,
} from '@tachybase/module-workflow/client';

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
      scopes={{
        ExecutionRetryAction,
        useCancelAction,
        useDumpAction,
        useRevisionAction,
      }}
    />
  ),
  aclSnippet: 'pm.workflow.workflows',
  sort: -10,
};
