import { useSchemaInitializerItem } from '../../../application';
import { OpenMode } from '../../../schema-component';
import { BlockInitializer } from '../../../schema-initializer/items/BlockInitializer';

export const CustomizeAddRecordActionInitializer = () => {
  const schema = {
    type: 'void',
    title: '{{t("Add record")}}',
    'x-toolbar': 'ActionSchemaToolbar',
    'x-settings': 'actionSettings:addRecord',
    'x-component': 'Action',
    'x-action': 'customize:create',
    'x-component-props': {
      openMode: OpenMode.DEFAULT,
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
            title: '{{ t("Add record") }}',
            'x-component': 'Page',
            properties: {
              grid: {
                type: 'void',
                'x-component': 'Grid',
                'x-initializer': 'popup:addRecord:addBlock',
              },
            },
          },
        },
      },
    },
  };
  const itemConfig = useSchemaInitializerItem();

  return <BlockInitializer {...itemConfig} schema={schema} item={itemConfig} />;
};
