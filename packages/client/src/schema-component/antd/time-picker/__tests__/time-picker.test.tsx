import React from 'react';
import { fireEvent, render, screen } from '@tachybase/test/client';

import App1 from '../demos/demo1';
import App2 from '../demos/demo2';

const clickOk = () => {
  const button = screen.getByText('OK').closest('button') as HTMLButtonElement;
  expect(button).toBeInTheDocument();
  fireEvent.click(button);
};

describe('TimePicker', () => {
  it('should display the value of user input', async () => {
    const { container } = render(<App1 />);
    const input = container.querySelector('input') as HTMLInputElement;

    // 1.先点击一下输入框，显示出时间选择器
    fireEvent.click(input);

    // 2.然后输入 12:00:00
    fireEvent.change(input, { target: { value: '12:00:00' } });

    // 3.然后点击 OK 按钮
    clickOk();

    expect(input.value).toBe('12:00:00');
    expect(screen.getByText('12:00:00')).toBeInTheDocument();
  }, 30000);
});

describe('TimePicker.RangePicker', () => {
  it('should display the value of user input', async () => {
    render(<App2 />);
    const startInput = screen.getByPlaceholderText('Start time') as HTMLInputElement;
    const endInput = screen.getByPlaceholderText('End time') as HTMLInputElement;

    // 设置开始时间
    fireEvent.click(startInput);
    fireEvent.change(startInput, { target: { value: '12:00:00' } });
    clickOk();

    // 设置结束时间
    fireEvent.click(endInput);
    fireEvent.change(endInput, { target: { value: '14:00:00' } });
    clickOk();

    expect(startInput.value).toBe('12:00:00');
    expect(endInput.value).toBe('14:00:00');
    expect(screen.getByText('12:00:00~14:00:00')).toBeInTheDocument();
  }, 30000);
});
