import { SchemaInitializerItemType, useSchemaInitializer } from '@tachybase/client';

import { featureNameLowerCase_formDesign } from '../constants';
import { tval, useTranslation } from '../locale';

export const formDesignInitializerItem: SchemaInitializerItemType = {
  name: featureNameLowerCase_formDesign,
  Component: 'DataBlockInitializer',
  useComponentProps: () => {
    const { insert } = useSchemaInitializer();
    const { t } = useTranslation();
    return {
      title: tval('Form design'),
      icon: 'FormOutlined',
      onCreateBlockSchema: ({ item }) => {},
    };
  },
};
