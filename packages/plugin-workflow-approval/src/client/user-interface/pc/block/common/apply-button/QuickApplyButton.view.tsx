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
import { ApplyActionStatusProvider } from '../providers/ActionStatus.provider';
import { WithdrawActionProvider } from '../providers/ActionWithdraw.provider';

export const QuickViewApplyButton = (props) => {
  const { schema, isCreate } = props;
  const components = {
    RemoteSchemaComponent,
    CollectionProvider_deprecated,
    ProviderContextWorkflow,
    ApplyActionStatusProvider,
    ActionBarProvider,
    WithdrawActionProvider,
    ProviderActionReminder,
    ProviderActionResubmit: () => null,
  };
  const scope = {
    useSubmit: useSubmitCreate,
    useWithdrawAction,
    useActionResubmit,
    useActionReminder,
  };
  return (
    <SchemaComponent
      schema={schema}
      components={
        isCreate
          ? { ...components }
          : {
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
            }
      }
      scope={
        isCreate
          ? { ...scope }
          : {
              useForm,
              useSubmit: useSubmitCreate,
              useFormBlockProps,
              useDetailsBlockProps: useFormBlockContext,
              useWithdrawAction,
              useDestroyAction,
              useActionResubmit,
              useActionReminder,
            }
      }
    />
  );
};
