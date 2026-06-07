import React from 'react';
import { render, screen, userEvent, waitFor, within } from '@tachybase/test/client';

import App2 from '../demos/demo2';
import App3 from '../demos/demo3';
import App4 from '../demos/demo4';
import App5 from '../demos/demo5';
import App6 from '../demos/demo6';

describe('Filter', () => {
  it('Filter & Action', async () => {
    render(<App3 />);

    const openButton = await screen.findByText(/open/i);
    await waitFor(() => {
      expect(openButton.closest('.ant-spin-blur')).not.toBeInTheDocument();
    });
    await userEvent.click(openButton);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();

    // 弹窗中显示的内容
    expect(within(tooltip).getByText(/^name$/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/^ne$/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
    expect(within(tooltip).getByText(/^tags \/ title$/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/^eq$/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
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
  }, 10000);

  it('default value', async () => {
    render(<App2 />);

    expect(screen.getByText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByText(/^ne$/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
    expect(screen.getByText(/^tags \/ title$/i)).toBeInTheDocument();
    expect(screen.getByText(/^eq$/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
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

    expect(screen.getByText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByText(/^ne$/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
    expect(screen.getByText(/^tags \/ title$/i)).toBeInTheDocument();
    expect(screen.getByText(/^eq$/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
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

    await userEvent.click(await screen.findByText(/filter/i));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();

    // 弹窗中显示的内容
    expect(within(tooltip).getByText(/^name$/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/^ne$/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
    expect(within(tooltip).getByText(/^tags \/ title$/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/^eq$/i, { selector: '.ant-select-selection-item' })).toBeInTheDocument();
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

    await userEvent.click(addBtn);
    const item = await waitFor(() => {
      const filterItem = document.querySelector('.nc-filter-item');
      expect(filterItem).toBeInTheDocument();
      return filterItem;
    });
    const selector = item.querySelector('.ant-select-selector');

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
  }, 15000);
});
