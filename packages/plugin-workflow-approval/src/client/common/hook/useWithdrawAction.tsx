import { useActionContext, useAPIClient, useIsMobile } from '@tachybase/client';
import { useField } from '@tachybase/schema';

import { Toast } from 'antd-mobile';
import { useNavigate } from 'react-router-dom';

import { useApproval, useContextApprovalExecution } from '..';
import { useHandleRefresh } from './useHandleRefresh';

// 撤回
export function useWithdrawAction() {
  const { refreshTable } = useHandleRefresh();
  const field = useField();
  const approval = useApproval();
  const api = useAPIClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  return {
    async run() {
      try {
        field.data = field.data ?? {};
        field.data.loading = true;

        const res = await api.resource('approvals').withdraw({
          filterByTk: approval.id,
        });
        if (refreshTable) {
          refreshTable();
        }
        if (res.status === 202 && isMobile) {
          Toast.show({
            icon: 'success',
            content: '撤回成功',
          });

          setTimeout(() => {
            navigate(-1);
          }, 1000);
        } else if (isMobile) {
          Toast.show({
            icon: 'fail',
            content: '撤回失败',
          });
        }
        field.data.loading = false;
      } catch (v) {
        if (field.data) {
          field.data.loading = false;
        }
      }
    },
  };
}
