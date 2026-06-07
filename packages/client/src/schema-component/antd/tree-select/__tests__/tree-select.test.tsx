import React from 'react';
import { fireEvent, render, screen, waitFor } from '@tachybase/test/client';

import App1 from '../demos/demo1';

describe('TreeSelect', () => {
  it('should display the value of user input', async () => {
    const { container } = render(<App1 />);
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.mouseDown(input);
    await waitFor(() => {
      expect(screen.getByText('选项1')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('选项1'));
    await waitFor(() => {
      expect(container.querySelector('.ant-select-selection-item')?.textContent).toBe('选项1');
    });
  }, 30000);
});
