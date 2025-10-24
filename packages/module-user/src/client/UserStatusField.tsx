import React from 'react';
import { useCollectionField, useCompile, useRecord } from '@tachybase/client';

import { Tag } from 'antd';

export const UserStatusField = () => {
  const record = useRecord();
  const field = useCollectionField();
  const compile = useCompile();
  const statusInfo = record?.statusInfo;

  if (!statusInfo) {
    return <span>-</span>;
  }

  const title = compile(statusInfo.title || statusInfo.key);

  return <Tag color={statusInfo.color || 'default'}>{title}</Tag>;
};
