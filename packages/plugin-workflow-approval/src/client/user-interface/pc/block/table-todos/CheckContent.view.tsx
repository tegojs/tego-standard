import { useContext } from 'react';
import {
  RemoteSchemaComponent,
  SchemaComponent,
  SchemaComponentProvider,
  useFormBlockContext,
} from '@tachybase/client';
import { DetailsBlockProvider } from '@tachybase/module-workflow/client';

import _ from 'lodash';

import {
  ApprovalActionProvider,
  ApprovalContext,
  FormBlockProvider,
  SchemaComponentContextProvider,
  useApprovalDetailBlockProps,
  useApprovalFormBlockProps,
  useSubmit,
} from '../../../../common';
import { getSchemaActionTodosContent } from './CheckContent.schema';
import { ActionBarProvider } from './providers/ActionBar.provider';
import { ApprovalFormBlockProvider } from './providers/ApprovalFormBlock.provider';

export const ViewCheckContent = (props) => {
  const approval = useContext(ApprovalContext);
  const { id, node, actionEnabled } = props;
  const schema = getSchemaActionTodosContent({ id, node, actionEnabled, approval });

  return (
    <SchemaComponent
      schema={schema}
      components={{
        SchemaComponentProvider,
        RemoteSchemaComponent,
        SchemaComponentContextProvider,
        FormBlockProvider,
        ActionBarProvider,
        ApprovalActionProvider,
        ApprovalFormBlockProvider,
        DetailsBlockProvider,
      }}
      scope={{
        useApprovalDetailBlockProps,
        useApprovalFormBlockProps,
        useDetailsBlockProps: useFormBlockContext,
        useSubmit,
      }}
    />
  );
};
