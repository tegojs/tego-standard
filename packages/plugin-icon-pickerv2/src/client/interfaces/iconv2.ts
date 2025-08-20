import { CollectionFieldInterface, defaultProps } from '@tachybase/client';

import { tval } from '../locale';

export class IconV2FieldInterface extends CollectionFieldInterface {
  name = 'iconv2';
  type = 'object';
  group = 'basic';
  order = 11;
  title = tval('IconV2');
  icon = 'FieldNumberOutlined';
  default = {
    type: 'belongsTo',
    interface: 'object',
    target: 'iconStorage',
    targetKey: 'id',
    uiSchema: {
      type: 'string',
      'x-component': 'IconPickerV2',
    },
  };
  availableTypes = ['string'];
  hasDefaultValue = true;
  properties = {
    ...defaultProps,
  };
}
