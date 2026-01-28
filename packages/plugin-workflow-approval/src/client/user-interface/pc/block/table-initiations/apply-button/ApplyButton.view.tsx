import { CollectionProvider_deprecated, RemoteSchemaComponent, SchemaComponent } from '@tachybase/client';
import { ProviderContextWorkflow } from '@tachybase/module-workflow/client';

import { useActionResubmit, useSubmitCreate, useWithdrawAction } from '../../../../../common';
import { ActionBarProvider } from '../../common/providers/ActionBar.provider';
import { ApplyActionStatusProvider } from '../../common/providers/ActionStatus.provider';
import { WithdrawActionProvider } from '../../common/providers/ActionWithdraw.provider';

// 审批-发起: 发起按钮
export const ViewApplyButton = (props) => {
  const { schema } = props;
  return (
    <SchemaComponent
      schema={schema}
      components={{
        RemoteSchemaComponent,
        CollectionProvider_deprecated,
        ProviderContextWorkflow,
        ApplyActionStatusProvider,
        ActionBarProvider,
        ProviderActionResubmit: () => null,
        WithdrawActionProvider,
      }}
      scope={{
        useSubmit: useSubmitCreate,
        useWithdrawAction,
        useActionResubmit,
      }}
    />
  );
};
