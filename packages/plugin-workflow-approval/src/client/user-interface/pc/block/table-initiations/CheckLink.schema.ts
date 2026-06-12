import { useActionContext } from '@tachybase/client';

import { useActionResubmit } from 'packages/plugin-workflow-approval/src/client/common';

import { tval } from '../../../../locale';

export const getSchemaActionLaunch = (params) => {
  const { record, popoverComponent, popoverComponentProps } = params;

  return {
    name: `view-${record.id}`,
    type: 'void',
    'x-component': 'Action.Link',
    title: '{{t("View")}}',
    properties: {
      drawer: {
        type: 'void',
        'x-component': popoverComponent,
        'x-component-props': {
          className: 'tb-action-popup',
          ...popoverComponentProps,
        },
        properties: {
          content: Object.assign(
            {
              type: 'void',
            },
            record.approvalId
              ? {}
              : {
                  'x-decorator': 'ProviderRecord',
                },
            {
              'x-component': 'CheckContent',
            },
          ),
        },
      },
    },
  };
};

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
            title: tval('凭证类型'),
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
                  filter: { 'config.centralized': true, enabled: true },
                },
              },
              style: {
                width: '100%',
              },
              placeholder: tval('请选择凭证类型'),
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
