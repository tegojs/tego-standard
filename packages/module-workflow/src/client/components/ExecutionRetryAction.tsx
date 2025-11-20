import React from 'react';
import { useCollectionRecordData, useDataBlockRequest, useDataBlockResource } from '@tachybase/client';

import { useNavigate } from 'react-router-dom';

import { getWorkflowExecutionsPath } from '../utils';

export const ExecutionRetryAction = () => {
  const executionData = useCollectionRecordData();
  const resource = useDataBlockResource();
  const service = useDataBlockRequest();
  const navigate = useNavigate();

  return {
    async onClick() {
      try {
        const {
          data: { data: newExecution },
        } = await resource.retry({
          filterByTk: executionData.id,
        });

        if (newExecution && newExecution.id) {
          // 获取 type 参数（从 URL 中提取）
          const localUrl = window.location.pathname;
          const type = localUrl.split('business-components/')[1]?.split('/')[0];
          navigate(getWorkflowExecutionsPath(newExecution.id, type));
        } else {
          service?.refresh();
        }
      } catch (error) {
        // 如果出错，仍然刷新列表
        service?.refresh();
      }
    },
  };
};
