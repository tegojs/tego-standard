import {
  joinCollectionName,
  useActionContext,
  useAPIClient,
  useBlockRequestContext,
  useCollection_deprecated,
  useIsMobile,
} from '@tachybase/client';
import { useFlowContext } from '@tachybase/module-workflow/client';
import { useField, useForm } from '@tachybase/schema';

import { Toast } from 'antd-mobile';
import _ from 'lodash';
import { useNavigate, useParams } from 'react-router-dom';

import { useContextApprovalExecution, useResubmit } from '..';
import { useContextApprovalStatus } from '../../user-interface/pc/block/common/providers/ActionStatus.provider';
import { cleanAssociationIds } from '../tools/cleanAssociationIds';

export function useSubmitCreate() {
  const form = useForm();
  const field = useField();
  const { setVisible } = useActionContext();
  const { __parent } = useBlockRequestContext();
  const collection = useCollection_deprecated();
  const status = useContextApprovalStatus();
  const apiClient = useAPIClient();
  const navigate = useNavigate();
  const params = useParams();
  const { id: workflowId } = params;
  const flowContext = useFlowContext();
  const { isResubmit } = useResubmit();
  const { approval } = useContextApprovalExecution();
  const { workflow } = flowContext || approval || {};
  const isMobile = useIsMobile();

  return {
    async run(args) {
      try {
        await form.submit();
        field.data = field.data || {};
        field.data.loading = true;
        delete form.values['createdAt'];
        delete form.values['updatedAt'];

        // 如果是复制操作（有 workflowKey），需要清洗关联字段的 id
        let dataToSubmit = form.values;
        if (isResubmit && workflow?.key) {
          dataToSubmit = cleanAssociationIds(form.values, collection);
        }

        const res = await apiClient.resource('approvals').create({
          values: {
            collectionName: joinCollectionName(collection.dataSource, collection.name),
            data: dataToSubmit,
            status: typeof args?.approvalStatus !== 'undefined' ? args?.approvalStatus : status,
            workflowId: workflow.id || workflowId,
            workflowKey: workflow.key,
          },
        });
        if (res.status === 200 && isMobile) {
          Toast.show({
            icon: 'success',
            content: '提交成功',
          });
          setTimeout(() => {
            navigate(-1);
          }, 1000);
        }
        form.reset();
        field.data.loading = false;
        const service = __parent?.service;
        if (service) {
          service.refresh();
        }
        if (setVisible) {
          setVisible(false, false);
        }
      } catch (error) {
        if (field.data) {
          field.data.loading = false;
        }
      }
    },
  };
}
