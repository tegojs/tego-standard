import { Plugin } from '@tachybase/client';
import { ExecutionPage, WorkflowPage } from '@tachybase/module-workflow/client';

import { ExecutionApprovalLink, WorkflowApprovalLink } from '../common/components/WorkflowApproval';
import { NAMESPACE, tval } from '../locale';
import { settingApproval, systemSettingName } from './Approval.setting';

// 审批-系统设置项-审批入口/审批表格展示
export class KitApprovalBase extends Plugin {
  async load() {
    this.app.systemSettingsManager.add('business-components' + '.' + systemSettingName, settingApproval);
    this.app.addComponents({
      WorkflowApprovalLink: WorkflowApprovalLink,
      ExecutionApprovalLink: ExecutionApprovalLink,
    });
    this.app.systemSettingsManager.add(`business-components.${systemSettingName}/:id`, {
      icon: 'workflow',
      title: tval('Approval flow'),
    });
    this.app.systemSettingsManager.add(`business-components.${systemSettingName}/:id.workflow`, {
      icon: 'workflow',
      title: tval('Approval flow'),
      Component: WorkflowPage,
      fullscreen: true,
      groupKey: `business-components.${systemSettingName}`,
    });

    this.app.systemSettingsManager.add(`business-components.${systemSettingName}/:id.executions`, {
      icon: 'workflow',
      title: tval('Approval flow'),
      Component: ExecutionPage,
      fullscreen: true,
      groupKey: `business-components.${systemSettingName}`,
    });
  }
}
