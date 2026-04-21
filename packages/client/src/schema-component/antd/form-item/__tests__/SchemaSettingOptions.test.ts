import { describe, expect, it } from 'vitest';

import { getDefaultFilterOperatorValue } from '../SchemaSettingOptions';

describe('getDefaultFilterOperatorValue', () => {
  it('should infer $dateBetween from DatePicker.RangePicker component', () => {
    const fieldSchema = {
      name: 'createdAt',
      'x-component-props': {
        component: 'DatePicker.RangePicker',
      },
    };

    const operatorList = [
      { label: 'is', value: '$dateOn', selected: true },
      { label: 'is between', value: '$dateBetween', schema: { 'x-component': 'DatePicker.RangePicker' } },
    ];

    expect(getDefaultFilterOperatorValue(fieldSchema as any, operatorList as any)).toBe('$dateBetween');
  });

  it('should fall back to selected operator when component does not imply one', () => {
    const operatorList = [
      { label: 'is', value: '$eq', selected: true },
      { label: 'is not', value: '$ne' },
    ];

    expect(getDefaultFilterOperatorValue({ name: 'title' } as any, operatorList as any)).toBe('$eq');
  });
});
