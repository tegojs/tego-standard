import { useContext } from 'react';
import {
  CollectionProvider_deprecated,
  DetailsBlockProvider,
  RemoteSchemaComponent,
  SchemaComponent,
  SchemaComponentProvider,
  useFormBlockContext,
} from '@tachybase/client';
import { ProviderContextWorkflow } from '@tachybase/module-workflow/client';
import { useForm } from '@tachybase/schema';

import {
  ContextWithActionEnabled,
  FormBlockProvider,
  ProviderActionReminder,
  ProviderActionResubmit,
  ProviderApplyActionStatus,
  SchemaComponentContextProvider,
  useActionReminder,
  useActionResubmit,
  useDestroyAction,
  useFormBlockProps,
  useSubmitCreate,
  useWithdrawAction,
} from '../../../../../common';
import { ActionBarProvider } from '../../common/providers/ActionBar.provider';
import { ApplyActionStatusProvider } from '../../common/providers/ActionStatus.provider';
import { WithdrawActionProvider } from '../../common/providers/ActionWithdraw.provider';

export const QuickViewApplyButton = (props) => {
  const { schema } = props;
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
        useSubmit: useSubmitCreate,
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
