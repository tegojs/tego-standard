import React from 'react';
import { render, screen, userEvent, waitFor, within } from '@tachybase/test/client';

import dayjs from 'dayjs';

import App2 from '../demos/demo2';
import App3 from '../demos/demo3';
import App4 from '../demos/demo4';
import App5 from '../demos/demo5';
import App6 from '../demos/demo6';
import { getCustomCondition } from '../useFilterActionProps';

describe('Filter', () => {
  it('Filter & Action', async () => {
    render(<App3 />);

    await waitFor(async () => {
      await userEvent.click(screen.getByText(/open/i));
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();

    // 弹窗中显示的内容
    expect(within(tooltip).getByText(/name/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/ne/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/tags \/ title/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/eq/i)).toBeInTheDocument();
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
    render(<App2 />);

    expect(screen.getByText(/name/i)).toBeInTheDocument();
    expect(screen.getByText(/ne/i)).toBeInTheDocument();
    expect(screen.getByText(/tags \/ title/i)).toBeInTheDocument();
    expect(screen.getByText(/eq/i)).toBeInTheDocument();
    expect(screen.getByText(/^Add condition$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Add condition group$/i)).toBeInTheDocument();

    const inputs = document.querySelectorAll('.ant-input');
    expect(inputs).toHaveLength(2);
    // 输入框中的默认值
    expect(inputs[0]).toHaveValue('');
    expect(inputs[1]).toHaveValue('aaa');
  });

  it('custom dynamic component', async () => {
    render(<App4 />);

    expect(screen.getByText(/name/i)).toBeInTheDocument();
    expect(screen.getByText(/ne/i)).toBeInTheDocument();
    expect(screen.getByText(/tags \/ title/i)).toBeInTheDocument();
    expect(screen.getByText(/eq/i)).toBeInTheDocument();
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
    render(<App5 />);

    await waitFor(() => userEvent.click(screen.getByText(/filter/i)));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();

    // 弹窗中显示的内容
    expect(within(tooltip).getByText(/name/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/ne/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/tags \/ title/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/eq/i)).toBeInTheDocument();
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
    render(<App6 />);

    await waitFor(() => {
      expect(screen.getByText(/test1/i)).toBeInTheDocument();
    });

    const addBtn = screen.getByText(/^Add condition$/i);
    const addGroupBtn = screen.getByText(/^Add condition group$/i);

    expect(addBtn).toBeInTheDocument();
    expect(addGroupBtn).toBeInTheDocument();

    await waitFor(() => userEvent.click(addBtn));
    const item = document.querySelector('.nc-filter-item');
    const selector = item.querySelector('.ant-select-selector');
    expect(item).toBeInTheDocument();

    await userEvent.click(selector);
    // 选中 Title1
    await userEvent.click(screen.getByText(/title1/i));
    expect(screen.getByText(/title1/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
    expect(screen.getByText(/contains/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();

    // 切换为 test2
    await userEvent.click(screen.getByText(/test1/i));
    await userEvent.click(screen.getByText(/test2/i, { selector: '.ant-select-item-option-content' }));
    await userEvent.click(selector);
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

  it('normalizes date-only custom filter values to full-day boundaries', () => {
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
    const localStart = start.replace(/Z$/, '');
    const localEnd = end.replace(/Z$/, '');
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
                $dateBetween: [dayjs(localStart).toISOString(), dayjs(localEnd).toISOString()],
              },
            },
            {
              date_receive: {
                $dateBetween: [dayjs(localStart).toISOString(), dayjs(localEnd).toISOString()],
              },
            },
          ],
        },
      ],
    });
  });
});
