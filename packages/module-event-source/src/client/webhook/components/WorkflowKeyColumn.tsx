import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useAPIClient, useCollectionRecordData, useTableBlockContext } from '@tachybase/client';

import { HistoryOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';

interface WorkflowTitleMap {
  [workflowKey: string]: string;
}

const WorkflowTitleContext = createContext<WorkflowTitleMap>({});
WorkflowTitleContext.displayName = 'WorkflowTitleContext';

export const useWorkflowTitleContext = () => {
  return useContext(WorkflowTitleContext);
};

export const WorkflowTitleProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tableContext = useTableBlockContext();
  const apiClient = useAPIClient();
  const [workflowTitleMap, setWorkflowTitleMap] = React.useState<WorkflowTitleMap>({});

  // 获取表格中的所有 webhooks 数据
  const webhooks = tableContext?.service?.data?.data || [];
  const workflowKeys = useMemo(() => {
    const keys = webhooks.map((webhook: any) => webhook.workflowKey).filter((key: string) => key && key.trim() !== '');
    // 去重并排序，确保依赖稳定
    return Array.from(new Set(keys)).sort();
  }, [webhooks]);

  const workflowKeysStr = useMemo(() => workflowKeys.join(','), [workflowKeys]);

  useEffect(() => {
    if (workflowKeys.length === 0) {
      setWorkflowTitleMap({});
      return;
    }

    // 批量查询所有 workflows
    const fetchWorkflowTitles = async () => {
      try {
        const { data } = await apiClient.request({
          url: 'workflows:list',
          method: 'get',
          params: {
            filter: {
              key: {
                $in: workflowKeys,
              },
            },
            fields: ['id', 'key', 'title'],
            paginate: false,
          },
        });

        const workflows = data?.data || [];
        const map: WorkflowTitleMap = {};

        workflows.forEach((workflow: any) => {
          if (workflow.key) {
            map[workflow.key] = workflow.title || workflow.key;
          }
        });

        setWorkflowTitleMap(map);
      } catch (error) {
        console.error('Failed to fetch workflow titles:', error);
      }
    };

    fetchWorkflowTitles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowKeysStr, apiClient]);

  return <WorkflowTitleContext.Provider value={workflowTitleMap}>{children}</WorkflowTitleContext.Provider>;
};

export const WorkflowKeyColumn = ({ onClick }: { onClick?: () => void }) => {
  const record = useCollectionRecordData();
  const workflowTitleMap = useWorkflowTitleContext();
  const displayText = record.workflowKey ? workflowTitleMap[record.workflowKey] || record.workflowKey : '-';
  const hasWorkflowKey = !!record.workflowKey;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' }}>
      {hasWorkflowKey && onClick && (
        <Tooltip title="查看执行历史">
          <Button
            type="text"
            size="small"
            icon={<HistoryOutlined style={{ color: '#1890ff' }} />}
            onClick={onClick}
            style={{ padding: 0, minWidth: 'auto', flexShrink: 0 }}
          />
        </Tooltip>
      )}
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}
        title={displayText}
      >
        {displayText}
      </span>
    </div>
  );
};
