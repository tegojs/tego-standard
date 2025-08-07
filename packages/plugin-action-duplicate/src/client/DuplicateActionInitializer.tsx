import { ActionInitializer, OpenMode } from '@tachybase/client';

export const DuplicateActionInitializer = (props) => {
  const schema = {
    type: 'void',
    'x-action': 'duplicate',
    'x-acl-action': 'create',
    title: '{{ t("Duplicate") }}',
    'x-component': 'Action.Link',
    'x-decorator': 'ACLActionProvider',
    'x-component-props': {
      openMode: OpenMode.DEFAULT,
      component: 'DuplicateAction',
    },
    properties: {
      pageModeContainer: {
        type: 'void',
        title: '{{ t("Duplicate") }}',
        'x-component': 'Action.Container',
        'x-component-props': {
          className: 'tb-action-popup',
        },
        properties: {
          page: {
            type: 'void',
            title: '{{ t("Duplicate") }}',
            'x-component': 'Page',
            properties: {
              grid: {
                type: 'void',
                'x-component': 'Grid',
                'x-initializer': 'popup:addNew:addBlock',
              },
            },
          },
        },
      },
    },
  };
  return <ActionInitializer {...props} schema={schema} />;
};
