import { CollectionFieldInterface, defaultProps } from '@tachybase/client';

import { tval } from './locale';

export class BankCardFieldInterface extends CollectionFieldInterface {
  name = 'bankCard';
  type = 'object';
  group = 'basic';
  order = 6;
  title = tval('Bank Card Number');
  description = tval('Bank card number field, formatted display in groups of 4 digits');

  default = {
    type: 'string',
    uiSchema: {
      type: 'string',
      'x-component': 'BankCardInput',
      'x-component-props': {},
    },
  };

  availableTypes = ['string'];
  hasDefaultValue = true;

  properties = {
    ...defaultProps,
  };

  filterable = {
    operators: [
      { label: '{{t("is")}}', value: '$eq', selected: true },
      { label: '{{t("is not")}}', value: '$ne' },
      { label: '{{t("contains")}}', value: '$includes' },
      { label: '{{t("does not contain")}}', value: '$notIncludes' },
      { label: '{{t("exists")}}', value: '$exists', noValue: true },
      { label: '{{t("not exists")}}', value: '$notExists', noValue: true },
    ],
  };
}
