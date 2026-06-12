import { useEffect, useState } from 'react';
import { SchemaComponent, useAPIClient, useRecord } from '@tachybase/client';

import { CheckContent } from './CheckContent';
import { getSchemaCreateActionLaunch } from './CheckLink.schema';
import { ProviderRecord } from './providers/Record.provider';

// 审批-发起: 操作-发起
export const CreateCheckLink = (props) => {
  const { popoverComponent = 'Action.Modal', popoverComponentProps = {} } = props;
  const record = useRecord();
  const schema = getSchemaCreateActionLaunch({ record, popoverComponent, popoverComponentProps });
  return (
    <SchemaComponent
      schema={schema}
      components={{
        ProviderRecord,
      }}
    />
  );
};
