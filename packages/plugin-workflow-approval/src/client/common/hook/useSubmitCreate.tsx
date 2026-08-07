import {
  joinCollectionName,
  useActionContext,
  useAPIClient,
  useBlockRequestContext,
  useCollection_deprecated,
  useFormBlockContext,
  useIsMobile,
} from '@tachybase/client';
import { useFlowContext } from '@tachybase/module-workflow/client';
import { useField, useForm } from '@tachybase/schema';

import { Toast } from 'antd-mobile';
import _ from 'lodash';
import { useNavigate, useParams } from 'react-router-dom';

import { useContextApprovalExecution, useQuickCreate, useResubmit } from '..';
import { useTranslation } from '../../locale';
import { useContextApprovalStatus } from '../../user-interface/pc/block/common/providers/ActionStatus.provider';
import { getCopyAssociationValues } from './copy-association-values';

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
  const { approval } = useContextApprovalExecution();
  const { isQuickCreate } = useQuickCreate();
  const { isResubmit } = useResubmit();
  const { updateAssociationValues = [] } = useFormBlockContext();
  const { workflow } = flowContext ?? approval ?? {};
  const isCopy = Boolean(isQuickCreate || isResubmit);
  const { t } = useTranslation();

  const isMobile = useIsMobile();

  return {
    async run(args) {
      let requestStarted = false;
      try {
        try {
          await form.submit();
          field.data = field.data || {};
          field.data.loading = true;
          delete form.values['createdAt'];
          delete form.values['updatedAt'];
          const resource = apiClient.resource('approvals');
          const copyPaths = getCopyAssociationValues(form, collection, updateAssociationValues);
          const selectedWorkflowId = workflow?.id || workflowId || approval?.workflow?.id;
          const selectedWorkflowKey = workflow?.key || approval?.workflow?.key;
          if (!selectedWorkflowId && !selectedWorkflowKey) {
            throw new Error(t('Approval workflow identifier is required'));
          }
          const request = resource.create({
            values: {
              collectionName: joinCollectionName(collection.dataSource, collection.name),
              data: form.values,
              status: typeof args?.approvalStatus !== 'undefined' ? args?.approvalStatus : status,
              workflowId: selectedWorkflowId,
              workflowKey: selectedWorkflowKey,
              isCopy,
              copyAssociationValues: copyPaths,
            },
          });
          requestStarted = true;
          const res = await request;
          if (res.status === 200 && isMobile) {
            Toast.show({
              icon: 'success',
              content: t('Submit succeeded'),
            });
            setTimeout(() => {
              navigate(-1);
            }, 1000);
          }
        } catch (error: any) {
          if (!requestStarted) {
            if (isMobile) {
              Toast.show({
                icon: 'fail',
                content: t('Submit failed'),
              });
            } else {
              apiClient.notification?.error({
                message: t('Submit failed'),
                description: error?.message,
              });
            }
          }
          return;
        }

        try {
          form.reset();
          const service = __parent?.service;
          if (service) {
            await service.refresh();
          }
          if (setVisible) {
            setVisible(false, false);
          }
        } catch (error: any) {
          if (isMobile) {
            Toast.show({
              icon: 'fail',
              content: t('Submission succeeded, but post-processing failed'),
            });
          } else {
            apiClient.notification?.error({
              message: t('Submission succeeded, but post-processing failed'),
              description: error?.message,
            });
          }
        }
      } finally {
        if (field.data) {
          field.data.loading = false;
        }
      }
    },
  };
}
