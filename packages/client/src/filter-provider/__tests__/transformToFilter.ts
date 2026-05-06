import { transformToFilter } from '../utils';

// TODO: 前端测试报错解决之后，把该文件重命名为 transformToFilter.test.ts
describe('transformToFilter', () => {
  it('should transform to filter', () => {
    const values = {
      name: 'name',
      email: 'email',
      user: {
        name: 'name',
      },
      list: [{ name: 'name1' }, { name: 'name2' }, { name: 'name3' }],
    };

    const fieldSchema = {
      'x-filter-operators': {
        name: '$eq',
        email: '$eq',
      },
    };

    const getField = (name: string) => {
      if (name === 'user' || name === 'list') {
        return {
          targetKey: 'name',
        };
      }
      return {
        targetKey: undefined,
      };
    };

    expect(transformToFilter(values, fieldSchema as any, getField)).toEqual({
      $and: [
        {
          name: {
            $eq: 'name',
          },
        },
        {
          email: {
            $eq: 'email',
          },
        },
        {
          'user.name': {
            $eq: 'name',
          },
        },
        {
          'list.name': {
            $eq: ['name1', 'name2', 'name3'],
          },
        },
      ],
    });
  });

  it('should use current field component to infer $dateBetween when stored operators are empty', () => {
    const values = {
      createdAt: ['2026-04-13T00:00:00.000Z', '2026-04-19T23:59:59.999Z'],
    };

    const fieldSchema = {
      'x-filter-operators': {},
      properties: {
        row: {
          properties: {
            col: {
              properties: {
                createdAt: {
                  name: 'createdAt',
                  'x-collection-field': 'receipt.createdAt',
                  'x-component-props': {
                    component: 'DatePicker.RangePicker',
                  },
                },
              },
            },
          },
        },
      },
    };

    const getField = () => ({
      targetKey: undefined,
      interface: 'createdAt',
    });

    expect(transformToFilter(values, fieldSchema as any, getField, 'receipt')).toEqual({
      $and: [
        {
          createdAt: {
            $dateBetween: ['2026-04-13T00:00:00.000Z', '2026-04-19T23:59:59.999Z'],
          },
        },
      ],
    });
  });
});
