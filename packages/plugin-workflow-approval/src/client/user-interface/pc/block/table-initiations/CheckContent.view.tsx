import React, { useContext } from 'react';
import {
  RemoteSchemaComponent,
  SchemaComponent,
  SchemaComponentProvider,
  useFormBlockContext,
} from '@tachybase/client';
import { DetailsBlockProvider } from '@tachybase/module-workflow/client';
import { useForm } from '@tachybase/schema';

import {
  ActionBarProvider,
  ContextWithActionEnabled,
  FormBlockProvider,
  ProviderActionReminder,
  ProviderActionResubmit,
  SchemaComponentContextProvider,
  useActionReminder,
  useActionResubmit,
  useDestroyAction,
  useFormBlockProps,
  useSubmitUpdate,
  useWithdrawAction,
  WithdrawActionProvider,
} from '../../../../common';
import { ProviderApplyActionStatus } from '../../../../common/contexts/ApplyActionStatus.provider';
import { getSchemaCheckContent } from './CheckContent.schema';

export const ViewCheckContent = (props) => {
  const { approval, workflow } = props;
  const { actionEnabled } = useContext(ContextWithActionEnabled);

  const schema = getSchemaCheckContent({ approval, workflow, needHideProcess: actionEnabled });

  return (
    <SchemaComponent
      schema={schema}
      components={{
        SchemaComponentProvider,
        RemoteSchemaComponent,
        SchemaComponentContextProvider,
        FormBlockProvider,
        ActionBarProvider,
        ApplyActionStatusProvider: ProviderApplyActionStatus,
        WithdrawActionProvider,
        DetailsBlockProvider,
        ProviderActionResubmit,
        ProviderActionReminder,
      }}
      scope={{
        useForm,
        useSubmit: useSubmitUpdate,
        useFormBlockProps,
        useDetailsBlockProps: useFormBlockContext,
        useWithdrawAction,
        useDestroyAction,
        useActionResubmit,
        useActionReminder,
      }}
    />
  );
};
