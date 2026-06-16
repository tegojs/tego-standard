import { SchemaComponent, useActionContext, useRecord } from '@tachybase/client';

import { tval } from '../../../../locale';

export const getSchemaCreateActionLaunch = (params) => {
  const { record, popoverComponent, popoverComponentProps } = params;

  return {
    name: `view-${record.id}`,
    type: 'void',
    'x-decorator': 'ACLActionProvider',
    'x-acl-action': 'receipt:create',
    'x-component': 'Action.Link',
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
                    'config.collection': record.collectionName,
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
                title: "{{t('Cancel', { ns: 'core' })}}",
                'x-component': 'Action',
                'x-component-props': {
                  useAction() {
                    const ctx = useActionContext();
                    return {
                      async run() {
                        ctx.setVisible(false);
                      },
                    };
                  },
                },
              },
              submit: {
                title: "{{t('Submit', { ns: 'core' })}}",
                'x-component': 'QuickApplyButton',
                'x-component-props': {
                  type: 'primary',
                  record,
                },
              },
            },
          },
        },
      },
    },
  };
};

// 审批-抄送: 操作-快速发起
export const CreateCheckLink = (props) => {
  const { popoverComponent = 'Action.Modal', popoverComponentProps = {} } = props;
  const record = useRecord();

  const schema = getSchemaCreateActionLaunch({
    record,
    popoverComponent,
    popoverComponentProps,
  });

  return <SchemaComponent schema={schema} />;
};
