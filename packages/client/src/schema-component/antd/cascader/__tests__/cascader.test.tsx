const cascaderField = {
  key: 'test-cascader',
  name: 'test_cascader',
  type: 'json',
  interface: 'cascader',
  collectionName: 'users',
  uiSchema: {
    type: 'array',
    title: 'Region',
    'x-component': 'Cascader',
    enum: [
      {
        value: 'zhejiang',
        label: 'Zhejiang',
        children: [{ value: 'hangzhou', label: 'Hangzhou' }],
      },
    ],
  },
};

describe('Cascader', () => {
  it('field resolves correctly', () => {
    expect(cascaderField.interface).toBe('cascader');
    expect(cascaderField.uiSchema.title).toBe('Region');
    expect(cascaderField.uiSchema['x-component']).toBe('Cascader');
    expect(cascaderField.uiSchema.enum[0].children[0].label).toBe('Hangzhou');
  });
});
