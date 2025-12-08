import React from 'react';
import { useCollectionRecordData } from '@tachybase/client';

import dayjs from 'dayjs';

export const ColumnExecutedTime = () => {
  const record = useCollectionRecordData();
  // 直接从 record 中获取 latestExecutedTime（由后端返回 UTC 时间 ISO 字符串）
  const utcTime = record.latestExecutedTime;

  // 将 UTC 时间转换为本地时间格式化显示
  const showTime = utcTime ? dayjs(utcTime).format('YYYY-MM-DD HH:mm:ss') : '-';

  return <div style={{ textAlign: 'left' }}>{showTime}</div>;
};
