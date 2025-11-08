import React from 'react';
import { useCollectionField, useCompile, useRecord } from '@tachybase/client';
import { useFieldSchema } from '@tachybase/schema';

import { Tag } from 'antd';

export const UserStatusField = () => {
  const record = useRecord();
  const field = useCollectionField();
  const compile = useCompile();
  const fieldSchema = useFieldSchema();

  // 优先使用固定的 statusInfo（向后兼容），否则通过 schema name 动态获取
  let statusInfo = record?.statusInfo;

  if (!statusInfo && fieldSchema?.name) {
    // 支持动态字段名（如 fromStatusInfo, toStatusInfo）
    statusInfo = record?.[fieldSchema.name];
  }

  if (!statusInfo) {
    return <span>-</span>;
  }

  const title = compile(statusInfo.title || statusInfo.key);

  return <Tag color={statusInfo.color || 'default'}>{title}</Tag>;
};
