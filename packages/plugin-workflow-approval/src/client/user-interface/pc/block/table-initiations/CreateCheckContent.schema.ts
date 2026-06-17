import { parseCollectionName } from '@tachybase/client';

import { NAMESPACE } from '../../../../locale';

export const getSchemaCreateCheckContent = (params) => {
  const { approval, workflow, needHideProcess } = params;
  const { applyForm } = workflow?.config ?? {};
  const [dataSource, name] = parseCollectionName(workflow?.config.collection);
  return {
    name: `view-${approval?.id}`,
    type: 'void',
    'x-decorator': 'CollectionProvider_deprecated',
    'x-decorator-props': {
      name,
      dataSource,
    },
    'x-component': 'RemoteSchemaComponent',
    'x-component-props': {
      uid: applyForm,
      noForm: true,
    },
  };
};
