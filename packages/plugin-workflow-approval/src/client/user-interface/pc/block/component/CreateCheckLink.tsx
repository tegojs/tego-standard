import {
  BlockInitializer,
  SchemaComponent,
  SchemaInitializerActionModal,
  useActionContext,
  useRecord,
  useSchemaInitializerItem,
} from '@tachybase/client';

import { Button, Dropdown } from 'antd';

import { tval, useTranslation } from '../../../../locale';
import { QuickApplyButton } from '../common/apply-button/QuickApplyButton.component';

export const CreateCheckCancelAction = () => {
  const ctx = useActionContext();
  const { t } = useTranslation();
  const onClick = () => {
    ctx.setVisible(false);
  };
  return <Button onClick={onClick}>{t('Cancel')}</Button>;
};

export const createCheckSubmitAction = () => {
  const ctx = useActionContext();
  const record = useRecord();
  return <QuickApplyButton props={{ record, type: 'primary', isCreate: true }} />;
};

export const getSchemaCreateActionLaunch = (params) => {
  const { record, popoverComponent, popoverComponentProps, component } = params;
  return {
    name: `view-${record.id}`,
    type: 'void',
    'x-decorator': 'ACLActionProvider',
    'x-acl-action': 'receipt:create',
    'x-component': 'Action',
    'x-action': 'customize:workflowsApproval',
    'x-designer': 'Action.Designer',
    title: tval('Quick Launch'),
    properties: {
      modal: {
        type: 'void',
        'x-decorator': 'FormV2',
        'x-component': popoverComponent,
        'x-component-props': {
          title: tval('Quick Launch'),
          className: 'tb-action-popup',
          ...popoverComponentProps,
        },
        properties: {
          voucherType: {
            type: 'number',
            title: tval('Receipt category'),
            required: true,
            'x-decorator': 'FormItem',
            'x-component': 'RemoteSelect',
            'x-component-props': {
              fieldNames: {
                label: 'title',
                value: 'id',
              },
              service: {
                resource: 'workflows',
                params: {
                  filter: {
                    'config.centralized': true,
                    enabled: true,
                    'config.collection': record.collectionName || record['__collectionName'],
                  },
                },
              },
              style: {
                width: '100%',
              },
              placeholder: tval('Please select the receipt category'),
            },
          },
          footer: {
            'x-component': 'Action.Modal.Footer',
            type: 'void',
            'x-component-props': {
              style: {
                display: 'flex',
                justifyContent: 'flex-end',
              },
            },
            properties: {
              cancel: {
                title: tval('Cancel'),
                'x-component': 'CreateCheckCancelAction',
              },
              submit: {
                title: tval('Submit'),
                'x-component': 'createCheckSubmitAction',
              },
            },
          },
        },
      },
    },
  };
};

// 凭证: 查看-快速发起
export const CreateCheckLink = (props) => {
  const { popoverComponent = 'Action.Modal', popoverComponentProps = {} } = props;
  const record = useRecord();

  const schema = getSchemaCreateActionLaunch({
    record,
    popoverComponent,
    popoverComponentProps,
  });
  const itemConfig = useSchemaInitializerItem();
  return <BlockInitializer {...itemConfig} schema={schema} item={itemConfig} />;
};
