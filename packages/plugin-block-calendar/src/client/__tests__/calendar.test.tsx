import React from 'react';
import { render, screen, waitFor } from '@tachybase/test/client';

import dayjs from 'dayjs';

import App1 from '../calendar/demos/demo1';
import App2 from '../calendar/demos/demo2';

describe('Calendar', () => {
  it('basic', async () => {
    render(<App1 />);

    const currentDate = dayjs().format('YYYY-M');

    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
      expect(screen.getByText(currentDate)).toBeInTheDocument();
      expect(screen.getByText('Month')).toBeInTheDocument();
    });
  });

  it('use CalendarBlockProvider', async () => {
    render(<App2 />);

    const currentDate = dayjs().format('YYYY-M');
    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
      expect(screen.getByText(currentDate)).toBeInTheDocument();
      expect(screen.getByText('Month')).toBeInTheDocument();
    });
  });
});
