import React from 'react';
import { useCollectionManager, useCollectionRecordData } from '@tachybase/client';

import { useEventSourceContext } from '../provider/EventSourceProvider';

export const ColumnShowEventSource = () => {
  const record = useCollectionRecordData();
  const { eventSourceList } = useEventSourceContext();
  let showName = '-';
  if (eventSourceList?.length) {
    const eventSource = eventSourceList?.filter((item) => {
      return item.workflowKey === record.key;
    })?.[0];
    showName = eventSource?.name || '';
  }

  return <div style={{ textAlign: 'left' }}>{showName}</div>;
};
