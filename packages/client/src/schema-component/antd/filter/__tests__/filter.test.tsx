import React from 'react';
import { fireEvent, render, screen, userEvent, waitFor, within } from '@tachybase/test/client';

import dayjs from 'dayjs';
import { MemoryRouter } from 'react-router-dom';

import { mapRangePicker } from '../../date-picker/util';
import App2 from '../demos/demo2';
import App3 from '../demos/demo3';
import App4 from '../demos/demo4';
import App5 from '../demos/demo5';
import App6 from '../demos/demo6';
import { getCustomCondition } from '../useFilterActionProps';

const renderWithRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('Filter', () => {
  it('Filter & Action', async () => {
    renderWithRouter(<App3 />);

    await waitFor(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open/i }));
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();

    // 弹窗中显示的内容
    expect(within(tooltip).getByText(/name/i)).toBeInTheDocument();
    expect(within(tooltip).getAllByText(/^ne$/i).length).toBeGreaterThan(0);
    expect(within(tooltip).getByText(/tags \/ title/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/^eq$/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/^Add condition$/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/^Add condition group$/i)).toBeInTheDocument();

    const inputs = tooltip.querySelectorAll('.ant-input');
    expect(inputs).toHaveLength(2);
    // 输入框中的默认值
    expect(inputs[0]).toHaveValue('aa');
    expect(inputs[1]).toHaveValue('aaa');

    // 点击下拉框中的选项，Popover 不应该关闭。详见：
    await userEvent.click(screen.getByText(/any/i));
    await userEvent.click(screen.getByText(/all/i));
    expect(tooltip).toBeInTheDocument();
  });

  it('default value', () => {
    renderWithRouter(<App2 />);

    expect(screen.getByText(/name/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^ne$/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/tags \/ title/i)).toBeInTheDocument();
    expect(screen.getByText(/^eq$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Add condition$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Add condition group$/i)).toBeInTheDocument();

    const inputs = document.querySelectorAll('.ant-input');
    expect(inputs).toHaveLength(2);
    // 输入框中的默认值
    expect(inputs[0]).toHaveValue('');
    expect(inputs[1]).toHaveValue('aaa');
  });

  it('custom dynamic component', async () => {
    renderWithRouter(<App4 />);

    expect(screen.getByText(/name/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^ne$/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/tags \/ title/i)).toBeInTheDocument();
    expect(screen.getByText(/^eq$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Add condition$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Add condition group$/i)).toBeInTheDocument();

    const selects = screen.getAllByText('默认');
    // 自定义组件中的选择框
    expect(selects[0]).toBeInTheDocument();
    expect(selects[1]).toBeInTheDocument();

    const inputs = document.querySelectorAll('.ant-input');
    expect(inputs).toHaveLength(2);
    // 输入框中的默认值
    expect(inputs[0]).toHaveValue('aaa');
    expect(inputs[1]).toHaveValue('bbb');
  });

  it('FilterAction', async () => {
    renderWithRouter(<App5 />);

    await waitFor(() => userEvent.click(screen.getByRole('button', { name: /filter/i })));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();

    // 弹窗中显示的内容
    expect(within(tooltip).getByText(/name/i)).toBeInTheDocument();
    expect(within(tooltip).getAllByText(/^ne$/i).length).toBeGreaterThan(0);
    expect(within(tooltip).getByText(/tags \/ title/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/^eq$/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/^Add condition$/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/^Add condition group$/i)).toBeInTheDocument();

    const inputs = tooltip.querySelectorAll('.ant-input');
    expect(inputs).toHaveLength(2);
    // 输入框中的默认值
    expect(inputs[0]).toHaveValue('');
    expect(inputs[1]).toHaveValue('aaa');

    // 点击下拉框中的选项，Popover 不应该关闭。详见：
    await userEvent.click(screen.getByText(/any/i));
    await userEvent.click(screen.getByText(/all/i));
    expect(tooltip).toBeInTheDocument();
  });

  it('dynamic options', async () => {
    renderWithRouter(<App6 />);

    await waitFor(() => {
      expect(screen.getByText(/test1/i)).toBeInTheDocument();
    });

    const addBtn = screen.getByText(/^Add condition$/i);
    const addGroupBtn = screen.getByText(/^Add condition group$/i);

    expect(addBtn).toBeInTheDocument();
    expect(addGroupBtn).toBeInTheDocument();

    await waitFor(() => userEvent.click(addBtn));
    const item = document.querySelector('.nc-filter-item');
    const selector = item.querySelector('[data-testid="select-filter-field"] .ant-select-selector');
    expect(item).toBeInTheDocument();

    await userEvent.click(selector);
    // 选中 Title1
    await userEvent.click(screen.getByText(/title1/i));
    expect(screen.getByText(/title1/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
    expect(screen.getByText(/contains/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();

    // 切换为 test2
    await userEvent.click(screen.getByText(/test1/i));
    await userEvent.click(screen.getByText(/test2/i, { selector: '.ant-select-item-option-content' }));
    await waitFor(() => {
      expect(screen.getByText(/test2/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
    });
    await userEvent.keyboard('{Escape}');
    const nextItems = document.querySelectorAll('.nc-filter-item');
    const nextItem = nextItems[nextItems.length - 1];
    const nextSelector = nextItem.querySelector('[data-testid="select-filter-field"] .ant-select-selector');
    fireEvent.mouseDown(nextSelector);
    fireEvent.click(nextSelector);
    // 选中 Title2
    await userEvent.click(screen.getByText(/title2/i));
    expect(screen.getByText(/title2/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
    expect(screen.getByText(/contains/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
  });

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

    expect(condition).toEqual({
      $and: [
        {
          $or: [
            {
              date_pay: {
                $dateBetween: [
                  dayjs(start).startOf('day').toISOString(),
                  dayjs(end.replace(/Z$/, '')).endOf('day').toISOString(),
                ],
              },
            },
            {
              date_receive: {
                $dateBetween: [
                  dayjs(start).startOf('day').toISOString(),
                  dayjs(end.replace(/Z$/, '')).endOf('day').toISOString(),
                ],
              },
            },
          ],
        },
      ],
    });
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
                $dateBetween: [
                  dayjs(start).startOf('day').toISOString(),
                  dayjs(end.replace(/Z$/, '')).endOf('day').toISOString(),
                ],
              },
            },
            {
              date_receive: {
                $dateBetween: [
                  dayjs(start).startOf('day').toISOString(),
                  dayjs(end.replace(/Z$/, '')).endOf('day').toISOString(),
                ],
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
            $dateBetween: [dayjs(rangeValue[0]).toISOString(), dayjs(rangeValue[1]).toISOString()],
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
