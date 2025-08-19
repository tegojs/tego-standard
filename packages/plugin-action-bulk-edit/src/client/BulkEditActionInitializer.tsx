import { BlockInitializer, OpenMode, useSchemaInitializerItem } from '@tachybase/client';

export const BulkEditActionInitializer = () => {
  const schema = {
    type: 'void',
    title: '{{t("Bulk edit")}}',
    'x-component': 'Action',
    'x-action': 'customize:bulkEdit',
    'x-action-settings': {
      updateMode: 'selected',
    },
    'x-component-props': {
      openMode: OpenMode.DRAWER_MODE,
      icon: 'EditOutlined',
    },
    properties: {
      pageModeContainer: {
        type: 'void',
        title: '{{ t("Bulk edit") }}',
        'x-component': 'Action.Container',
        'x-component-props': {
          className: 'tb-action-popup',
        },
        properties: {
          page: {
            type: 'void',
            title: '{{ t("Bulk edit") }}',
            'x-component': 'Page',
            properties: {
              grid: {
                type: 'void',
                'x-component': 'Grid',
                'x-initializer': 'popup:bulkEdit:addBlock',
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
