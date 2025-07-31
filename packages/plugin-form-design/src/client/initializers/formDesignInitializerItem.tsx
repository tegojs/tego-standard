import { Icon, SchemaInitializerItemType } from '@tachybase/client';

import { featureNameLowerCase_formDesign } from '../constants';
import { tval } from '../locale';
import { EditableFormBlockInitializer } from './EditableFormBlockInitialzer';

export const formDesignInitializerItem: SchemaInitializerItemType = {
  type: 'subMenu',
  name: featureNameLowerCase_formDesign,
  title: tval('Form design'),
  icon: <Icon type="FormOutlined" />,
  Component: EditableFormBlockInitializer,
};
