import { useEffect } from 'react';
import {
  useActionContext,
  useCancelAction,
  useCollectionRecordData,
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
  const { setVisible, visible } = useActionContext();
  const filterByTk = useFilterByTk();
  const { values, setInitialValues } = useForm();
  const record = useCollectionRecordData();

  // 当 Modal 打开时，设置分类的默认值为当前工作流的分类
  useEffect(() => {
    if (visible && record?.category) {
      // 直接使用对象数组，这样 CollectionField 可以正确显示分类名称
      // 提交时会自动转换为 ID 数组
      setInitialValues({
        category: record.category,
      });
    }
  }, [visible, record, setInitialValues]);

  return {
    async run() {
      // 确保提交时分类字段是 ID 数组格式
      const submitValues = { ...values };
      if (submitValues.category && Array.isArray(submitValues.category)) {
        submitValues.category = submitValues.category.map((item) =>
          typeof item === 'object' && item?.id != null ? item.id : item,
        );
      }
      await resource.revision({ filterByTk, values: submitValues });
      message.success(t('Operation succeeded'));
      refresh();
      setVisible(false);
    },
  };
}
