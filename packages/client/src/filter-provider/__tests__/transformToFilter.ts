import dayjs from 'dayjs';

import { mapRangePicker } from '../../schema-component/antd/date-picker/util';
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

  it('should use current date-only range field component to infer $dateBetween when stored operators are empty', () => {
    const start = '2026-04-13T00:00:00.000Z';
    const end = '2026-04-19T23:59:59.999Z';
    const values = {
      createdAt: [start, end],
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
            $dateBetween: [start, end],
          },
        },
      ],
    });
  });

  it('should use DatePicker range mode metadata instead of boundary strings when normalizing date ranges', () => {
    let rangeValue: any[];
    const dateOnlyMapped = mapRangePicker()({
      showTime: false,
      utc: true,
      onChange: (nextValue: any[]) => {
        rangeValue = nextValue;
      },
    });
    dateOnlyMapped.onChange([dayjs('2026-05-01 00:00:00'), dayjs('2026-05-19 00:00:00')]);

    const values = {
      createdAt: rangeValue,
    };

    const fieldSchema = {
      'x-filter-operators': {
        createdAt: '$dateBetween',
      },
      properties: {
        createdAt: {
          name: 'createdAt',
          'x-component-props': {
            component: 'DatePicker.RangePicker',
            showTime: true,
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
            $dateBetween: rangeValue,
          },
        },
      ],
    });
  });

  it('should preserve unmarked retained date-only boundaries for ordinary range fields after enabling time', () => {
    let rangeValue: any[];
    const dateOnlyMapped = mapRangePicker()({
      showTime: false,
      utc: true,
      onChange: (nextValue: any[]) => {
        rangeValue = nextValue;
      },
    });
    dateOnlyMapped.onChange([dayjs('2026-05-01 00:00:00'), dayjs('2026-05-19 00:00:00')]);

    const copiedRangeValue = [rangeValue[0], rangeValue[1]];
    const values = {
      createdAt: copiedRangeValue,
    };

    const fieldSchema = {
      'x-filter-operators': {
        createdAt: '$dateBetween',
      },
      properties: {
        createdAt: {
          name: 'createdAt',
          'x-component-props': {
            component: 'DatePicker.RangePicker',
            showTime: true,
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
            $dateBetween: copiedRangeValue,
          },
        },
      ],
    });
  });

  it('should preserve explicit boundary-looking times from datetime range fields', () => {
    let rangeValue: any[];
    const datetimeMapped = mapRangePicker()({
      showTime: true,
      utc: true,
      onChange: (nextValue: any[]) => {
        rangeValue = nextValue;
      },
    });
    datetimeMapped.onChange([dayjs('2026-05-01 00:00:00'), dayjs('2026-05-19 23:59:59')]);

    const values = {
      createdAt: rangeValue,
    };

    const fieldSchema = {
      'x-filter-operators': {
        createdAt: '$dateBetween',
      },
      properties: {
        createdAt: {
          name: 'createdAt',
          'x-component-props': {
            component: 'DatePicker.RangePicker',
            showTime: true,
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
            $dateBetween: [dayjs(rangeValue[0]).toISOString(), dayjs(rangeValue[1]).toISOString()],
          },
        },
      ],
    });
  });
});
