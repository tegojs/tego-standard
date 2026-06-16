import React from 'react';
import { render, screen, userEvent, waitFor } from '@tachybase/test/client';

import App1 from '../demos/demo1';

describe('Tabs', () => {
  it('basic', async () => {
    render(<App1 />);

    expect(await screen.findByText('Tab1')).toBeInTheDocument();
    expect(await screen.findByText('Tab2')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Tab1'));
    await waitFor(() => {
      expect(screen.getByText('Hello1')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('Tab2'));
    await waitFor(() => {
      expect(screen.getByText('Hello2')).toBeInTheDocument();
    });
  });
});
