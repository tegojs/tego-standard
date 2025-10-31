import React, { useEffect } from 'react';
import { useCollectionRecordData, useRequest } from '@tachybase/client';

import dayjs from 'dayjs';

export const ColumnExecutedTime = () => {
  const record = useCollectionRecordData();
  let showName = '-';
  const { data, run } = useRequest(
    {
      resource: 'executions',
      action: 'list',
      params: {
        filter: {
          key: { $eq: record.key },
        },
        sort: ['-createdAt'],
        pageSize: 1,
      },
    },
    {
      manual: true,
    },
  );

  if (data?.['data'].length) {
    showName = dayjs(data['data'][0].createdAt).format('YYYY-MM-DD HH:mm:ss');
  }

  useEffect(() => {
    run();
  }, [record]);

  return <div style={{ textAlign: 'left' }}>{showName}</div>;
};
