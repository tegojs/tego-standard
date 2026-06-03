import dayjs from 'dayjs';

import { mapRangePicker } from '../../date-picker/util';
import { getCustomCondition } from '../conditionUtils';

describe('filter condition utils', () => {
  it('keeps literal values when applying custom filter variables', () => {
    const condition = getCustomCondition(
      { z9h1ihf3d6u: 'Test Corp' },
      {
        'x-filter-rules': {
          $and: [
            {
              category: {
                $eq: '3',
              },
            },
            {
              company_pay: {
                name: {
                  $includes: '{{$nFilter.z9h1ihf3d6u}}',
                },
              },
            },
          ],
        },
      },
    );

    expect(condition).toEqual({
      $and: [
        {
          category: {
            $eq: '3',
          },
        },
        {
          company_pay: {
            name: {
              $includes: 'Test Corp',
            },
          },
        },
      ],
    });
  });

  it('expands array custom filter values into alternative conditions', () => {
    const condition = getCustomCondition(
      { type: ['1', '2'] },
      {
        'x-filter-rules': {
          $and: [
            {
              category: {
                $eq: '3',
              },
            },
            {
              id: {
                $eq: '{{$nFilter.type}}',
              },
            },
          ],
        },
      },
    );

    expect(condition).toEqual({
      $and: [
        {
          category: {
            $eq: '3',
          },
        },
        {
          $or: [
            {
              id: {
                $eq: '1',
              },
            },
            {
              id: {
                $eq: '2',
              },
            },
          ],
        },
      ],
    });
  });

  it('skips nested array custom filter branches when the selected values are empty', () => {
    const condition = getCustomCondition(
      { type: [] },
      {
        'x-filter-rules': {
          $and: [
            {
              $or: [
                {
                  $and: [
                    {
                      category: {
                        $eq: '1',
                      },
                    },
                  ],
                },
                {
                  category: {
                    $eq: '{{$nFilter.type}}',
                  },
                },
              ],
            },
          ],
        },
      },
    );

    expect(condition).toEqual({
      $and: [
        {
          $or: [
            {
              $and: [
                {
                  category: {
                    $eq: '1',
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(condition)).not.toContain('"$or":[]');
  });

  it('normalizes date-only custom range picker values to full-day boundaries', () => {
    const start = '2026-05-01T00:00:00.000Z';
    const end = '2026-05-19T23:59:59.999Z';
    const condition = getCustomCondition(
      { date: [start, end] },
      {
        properties: {
          '__custom.date': {
            name: '__custom.date',
            'x-component': 'DatePicker.RangePicker',
          },
        },
        'x-filter-rules': {
          $and: [
            {
              $or: [
                {
                  date_pay: {
                    $dateBetween: '{{$nFilter.date}}',
                  },
                },
                {
                  date_receive: {
                    $dateBetween: '{{$nFilter.date}}',
                  },
                },
              ],
            },
          ],
        },
      },
    );

    const normalizedStart = dayjs(start).startOf('day').toISOString();
    const actualDates = condition?.$and?.[0]?.$or?.[0]?.date_pay?.$dateBetween;
    expect(actualDates).toBeDefined();
    expect(condition).toEqual({
      $and: [
        {
          $or: [{ date_pay: { $dateBetween: actualDates } }, { date_receive: { $dateBetween: actualDates } }],
        },
      ],
    });
    expect(actualDates[0]).toBe(normalizedStart);
  });

  it('normalizes date-only custom filter string values to full-day boundaries', () => {
    const start = '2026-05-01';
    const end = '2026-05-19';
    const condition = getCustomCondition(
      { date: [start, end] },
      {
        'x-filter-rules': {
          $and: [
            {
              $or: [
                {
                  date_pay: {
                    $dateBetween: '{{$nFilter.date}}',
                  },
                },
                {
                  date_receive: {
                    $dateBetween: '{{$nFilter.date}}',
                  },
                },
              ],
            },
          ],
        },
      },
    );

    expect(condition).toEqual({
      $and: [
        {
          $or: [
            {
              date_pay: {
                $dateBetween: [dayjs(start).startOf('day').toISOString(), dayjs(end).endOf('day').toISOString()],
              },
            },
            {
              date_receive: {
                $dateBetween: [dayjs(start).startOf('day').toISOString(), dayjs(end).endOf('day').toISOString()],
              },
            },
          ],
        },
      ],
    });
  });

  it('preserves explicit time points for date-between custom filter values', () => {
    const start = '2026-05-01T08:30:00.000Z';
    const end = '2026-05-19T18:45:00.000Z';
    const condition = getCustomCondition(
      { date: [start, end] },
      {
        properties: {
          '__custom.date': {
            name: '__custom.date',
            'x-component': 'DatePicker.RangePicker',
            'x-component-props': {
              showTime: true,
            },
          },
        },
        'x-filter-rules': {
          $and: [
            {
              $or: [
                {
                  date_pay: {
                    $dateBetween: '{{$nFilter.date}}',
                  },
                },
                {
                  date_receive: {
                    $dateBetween: '{{$nFilter.date}}',
                  },
                },
              ],
            },
          ],
        },
      },
    );

    expect(condition).toEqual({
      $and: [
        {
          $or: [
            {
              date_pay: {
                $dateBetween: [dayjs(start).toISOString(), dayjs(end).toISOString()],
              },
            },
            {
              date_receive: {
                $dateBetween: [dayjs(start).toISOString(), dayjs(end).toISOString()],
              },
            },
          ],
        },
      ],
    });
  });

  it('uses retained date-only range metadata for custom filter values after enabling time', () => {
    let rangeValue: any[];
    const dateOnlyMapped = mapRangePicker()({
      showTime: false,
      utc: true,
      onChange: (nextValue: any[]) => {
        rangeValue = nextValue;
      },
    });
    dateOnlyMapped.onChange([dayjs('2026-05-01 00:00:00'), dayjs('2026-05-19 00:00:00')]);

    const condition = getCustomCondition(
      { date: rangeValue },
      {
        properties: {
          '__custom.date': {
            name: '__custom.date',
            'x-component': 'DatePicker.RangePicker',
            'x-component-props': {
              showTime: true,
            },
          },
        },
        'x-filter-rules': {
          $and: [
            {
              date_pay: {
                $dateBetween: '{{$nFilter.date}}',
              },
            },
          ],
        },
      },
    );

    expect(condition).toEqual({
      $and: [
        {
          date_pay: {
            $dateBetween: [
              dayjs('2026-05-01 00:00:00').startOf('day').toISOString(),
              dayjs('2026-05-19 23:59:59.999').endOf('day').toISOString(),
            ],
          },
        },
      ],
    });
  });

  it('normalizes retained date-only range fallback for custom filter values when metadata is lost', () => {
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
    const condition = getCustomCondition(
      { date: copiedRangeValue },
      {
        properties: {
          '__custom.date': {
            name: '__custom.date',
            'x-component': 'DatePicker.RangePicker',
            'x-component-props': {
              showTime: true,
            },
          },
        },
        'x-filter-rules': {
          $and: [
            {
              date_pay: {
                $dateBetween: '{{$nFilter.date}}',
              },
            },
          ],
        },
      },
    );

    expect(condition).toEqual({
      $and: [
        {
          date_pay: {
            $dateBetween: [
              dayjs('2026-05-01 00:00:00').startOf('day').toISOString(),
              dayjs('2026-05-19 23:59:59.999').endOf('day').toISOString(),
            ],
          },
        },
      ],
    });
  });

  it('normalizes CollectionField date range values from component props', () => {
    const values = ['2026-04-30T16:00:00.000Z', '2026-05-03T15:59:59.999Z'];
    const condition = getCustomCondition(
      { date: values },
      {
        properties: {
          '__custom.date': {
            name: '__custom.date',
            'x-component': 'CollectionField',
            'x-component-props': {
              component: 'DatePicker.RangePicker',
              showTime: false,
            },
          },
        },
        'x-filter-rules': {
          $and: [
            {
              date_receive: {
                $dateBetween: '{{$nFilter.date}}',
              },
            },
          ],
        },
      },
    );

    expect(condition).toEqual({
      $and: [
        {
          date_receive: {
            $dateBetween: values,
          },
        },
      ],
    });
  });

  it('preserves explicit boundary-looking datetime metadata for custom filter values', () => {
    let rangeValue: any[];
    const datetimeMapped = mapRangePicker()({
      showTime: true,
      utc: true,
      onChange: (nextValue: any[]) => {
        rangeValue = nextValue;
      },
    });
    datetimeMapped.onChange([dayjs('2026-05-01 00:00:00'), dayjs('2026-05-19 23:59:59')]);

    const condition = getCustomCondition(
      { date: rangeValue },
      {
        properties: {
          '__custom.date': {
            name: '__custom.date',
            'x-component': 'DatePicker.RangePicker',
            'x-component-props': {
              showTime: true,
            },
          },
        },
        'x-filter-rules': {
          $and: [
            {
              date_pay: {
                $dateBetween: '{{$nFilter.date}}',
              },
            },
          ],
        },
      },
    );

    expect(condition).toEqual({
      $and: [
        {
          date_pay: {
            $dateBetween: [dayjs(rangeValue[0]).toISOString(), dayjs(rangeValue[1]).toISOString()],
          },
        },
      ],
    });
  });
});
