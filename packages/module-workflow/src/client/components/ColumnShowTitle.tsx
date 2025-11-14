import { useCollectionRecordData, useCompile, usePlugin } from '@tachybase/client';

import { Tooltip } from 'antd';

export const ColumnShowTitle = () => {
  const record = useCollectionRecordData();
  const compile = useCompile();
  const workflowPlugin = usePlugin('workflow') as any;

  const triggersOptions = workflowPlugin.getTriggersOptions();

  const { type, title } = record;
  const target = triggersOptions.find((trigger) => trigger.value === type);

  return (
    <Tooltip title={compile(target.label)} placement="right" color={'cyan'} style={{}}>
      <span
        style={{
          display: 'inline-block',
          maxWidth: 300,
          textAlign: 'left',
          cursor: 'pointer',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </span>
    </Tooltip>
  );
};
