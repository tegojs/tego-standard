import { RemoteSchemaComponent } from '@tachybase/client';

import { Card } from 'antd';

import { ApprovalsSummary } from '../../../../common/components/ApprovalsSummary';
import { useContexWorkflowNotice } from './contexts/WorkflowNotice.context';

export function NoticeDetailData({ uid }: { uid: string }) {
  const { execution, summary, collectionName } = useContexWorkflowNotice();
  const hasSummary = summary && typeof summary === 'object' && Object.keys(summary).length > 0;

  // Archived snapshots may omit associations needed by the detail schema's formulas.
  // 归档快照可能缺少详情公式依赖的关联数据，使用当时保存的摘要。
  if (!execution && hasSummary) {
    return (
      <Card>
        <ApprovalsSummary value={summary} collectionName={collectionName} />
      </Card>
    );
  }

  return <RemoteSchemaComponent uid={uid} noForm />;
}
