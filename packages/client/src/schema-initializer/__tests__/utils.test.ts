import { createFilterAssociatedResultSchema } from '../utils';

describe('schema initializer utils', () => {
  test('creates associated filter field schema with component props fallback', () => {
    const schema = createFilterAssociatedResultSchema(
      'accountItemList.accounts',
      { interface: 'm2o' },
      'receipt',
      'field-path',
    );

    expect(schema.schema).toMatchObject({
      name: 'accountItemList.accounts',
      'x-settings': 'fieldSettings:FilterFormItem',
      'x-component': 'CollectionField',
      'x-collection-field': 'receipt.accountItemList.accounts',
      'x-component-props': {},
    });
  });
});
