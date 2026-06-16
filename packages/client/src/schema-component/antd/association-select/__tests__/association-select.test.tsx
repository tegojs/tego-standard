import React from 'react';
import { render, screen, userEvent, waitFor } from '@tachybase/test/client';

import App1 from '../demos/demo1';

describe('AssociationSelect', () => {
  it('should render correctly', async () => {
    render(<App1 />);

    const selector = document.querySelector('.ant-select-selector');
    expect(selector).toBeInTheDocument();

    await userEvent.click(selector);

    // 等待接口返回数据
    await waitFor(() => {
      expect(screen.getByText('title1')).toBeInTheDocument();
      expect(screen.getByText('title2')).toBeInTheDocument();
    });
  });
});
