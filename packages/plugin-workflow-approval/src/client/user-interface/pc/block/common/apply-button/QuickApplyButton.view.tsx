import {
  DetailsBlockProvider,
  RemoteSchemaComponent,
  SchemaComponent,
  SchemaComponentProvider,
  useFormBlockContext,
} from '@tachybase/client';
import { useForm } from '@tachybase/schema';

import {
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
import { ActionBarProvider } from '../providers/ActionBar.provider';
import { WithdrawActionProvider } from '../providers/ActionWithdraw.provider';

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
