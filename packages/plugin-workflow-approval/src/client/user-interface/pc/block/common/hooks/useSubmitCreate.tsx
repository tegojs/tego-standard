import {
  joinCollectionName,
  useActionContext,
  useAPIClient,
  useBlockRequestContext,
  useCollection_deprecated,
} from '@tachybase/client';
import { useFlowContext } from '@tachybase/module-workflow/client';
import { useField, useForm } from '@tachybase/schema';

import _ from 'lodash';

import { cleanAssociationIds } from '../../../../../common/tools/cleanAssociationIds';
import { useResubmit } from '../../../common/Resubmit.provider';
import { useContextApprovalStatus } from '../providers/ActionStatus.provider';

export function useSubmitCreate() {
  const form = useForm();
  const field = useField();
  const { setVisible } = useActionContext();
  const { __parent } = useBlockRequestContext();
  const collection = useCollection_deprecated();
  const status = useContextApprovalStatus();
  const apiClient = useAPIClient();
  const flowContext = useFlowContext();
  const { isResubmit } = useResubmit();
  console.log('%c Line:27 🍔 isResubmit', 'font-size:18px;color:#6ec1c2;background:#7f2b82', isResubmit);
  const { workflow } = flowContext || {};

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

        await apiClient.resource('approvals').create({
          values: {
            collectionName: joinCollectionName(collection.dataSource, collection.name),
            data: dataToSubmit,
            status: typeof args?.approvalStatus !== 'undefined' ? args?.approvalStatus : status,
            workflowId: workflow?.id,
            workflowKey: workflow?.key,
          },
        });
        form.reset();
        field.data.loading = false;
        const service = __parent.service;
        if (service) {
          service.refresh();
        }
        setVisible(false, false);
      } catch (error) {
        if (field.data) {
          field.data.loading = false;
        }
      }
    },
  };
}
