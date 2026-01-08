import { useActionContext, useAPIClient, useFormBlockContext, useIsMobile } from '@tachybase/client';
import { useFlowContext } from '@tachybase/module-workflow/client';
import { useField, useForm } from '@tachybase/schema';

import { Toast } from 'antd-mobile';
import _ from 'lodash';
import { useNavigate } from 'react-router-dom';

import { useApproval, useContextApprovalExecution, useContextApprovalStatus, useResubmit } from '..';
import { useHandleRefresh } from './useHandleRefresh';
import { useSubmitCreate } from './useSubmitCreate';

export function useSubmitUpdate() {
  const { refreshTable } = useHandleRefresh();
  const apiClient = useAPIClient();
  const { approval } = useContextApprovalExecution();
  const { setSubmitted } = useActionContext() as any;
  const { isResubmit } = useResubmit();
  const { run: create } = useSubmitCreate();
  const status = useContextApprovalStatus();
  const navigate = useNavigate();

  const form = useForm();
  const field = useField();

  const { id } = useApproval();
  const flowCtx = useFlowContext();
  const workflow = flowCtx?.workflow || approval.workflow;
  const contextApprovalStatus = useContextApprovalStatus();
  const { updateAssociationValues } = useFormBlockContext();
  const isMobile = useIsMobile();
  return {
    async run(props) {
      if (isResubmit) {
        return await create({ approvalStatus: status });
      }
      try {
        await form.submit();
        _.set(field, ['data', 'loading'], true);

        const res = await apiClient.resource('approvals').update({
          filterByTk: id,
          values: {
            collectionName: workflow.config.collection,
            data: form.values,
            status: contextApprovalStatus,
            summaryConfig: workflow.config.summary,
            // NOTE: 告诉后端该同步更新哪些关联字段, 比如审批的明细项
            updateAssociationValues,
          },
        });
        if (res.status === 200 && isMobile) {
          Toast.show({
            icon: 'success',
            content: '处理成功',
          });
          setTimeout(() => {
            navigate(-1);
          }, 1000);
          setSubmitted(true);
        } else if (isMobile) {
          Toast.show({
            icon: 'fail',
            content: '处理失败',
          });
        }
        form.reset();
        _.set(field, ['data', 'loading'], false);
        if (refreshTable) {
          refreshTable();
        }
      } catch (m) {
        _.set(field, ['data', 'loading'], false);
      }
    },
  };
}
