import React from 'react';
import { useCollectionRecordData } from '@tachybase/client';

export const ColumnShowEventSource = () => {
  const record = useCollectionRecordData();
  // 直接从 record 中获取 eventSourceName（由后端 listExtended action 附加）
  const showName = record.eventSourceName || '-';

  return <div style={{ textAlign: 'left' }}>{showName}</div>;
};
