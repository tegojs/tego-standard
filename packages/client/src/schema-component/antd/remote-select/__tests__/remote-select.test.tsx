import React from 'react';
import { render, screen, userEvent } from '@tachybase/test/client';

import App1 from '../demos/demo1';

describe('RemoteSelect', () => {
  it('should render correctly', async () => {
    render(<App1 />);

    const selector = document.querySelector('.ant-select-selector');
    expect(selector).toBeInTheDocument();

    await userEvent.click(selector);

    expect(await screen.findByText('title1')).toBeInTheDocument();
    expect(await screen.findByText('title2')).toBeInTheDocument();
  });
});
