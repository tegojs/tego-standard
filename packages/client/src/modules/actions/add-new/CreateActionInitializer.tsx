import { useSchemaInitializerItem } from '../../../application';
import { OpenMode } from '../../../schema-component';
import { ActionInitializer } from '../../../schema-initializer/items/ActionInitializer';

export const CreateActionInitializer = () => {
  const schema = {
    type: 'void',
    'x-action': 'create',
    'x-acl-action': 'create',
    title: "{{t('Add new')}}",
    'x-toolbar': 'ActionSchemaToolbar',
    'x-settings': 'actionSettings:addNew',
    'x-component': 'Action',
    'x-decorator': 'ACLActionProvider',
    'x-component-props': {
      openMode: OpenMode.DEFAULT,
      type: 'primary',
      component: 'CreateRecordAction',
      icon: 'PlusOutlined',
    },
    properties: {
      pageModeContainer: {
        type: 'void',
        title: '{{ t("Add record") }}',
        'x-component': 'Action.Container',
        'x-component-props': {
          className: 'tb-action-popup',
        },
        properties: {
          page: {
            type: 'void',
            title: '{{t("Add new")}}',
            'x-component': 'Page',
            properties: {
              grid: {
                type: 'void',
                'x-component': 'Grid',
                'x-initializer': 'popup:common:addBlock',
              },
            },
          },
        },
      },
    },
  };
  const itemConfig = useSchemaInitializerItem();
  return <ActionInitializer {...itemConfig} item={itemConfig} schema={schema} />;
};
