import React from 'react';
import { render, screen } from '@tachybase/test/client';

import dayjs from 'dayjs';

import { Root as App1 } from '../calendar/demos/demo1';

const assertCalendarRendered = async () => {
  const currentDate = dayjs().format('YYYY-M');

  expect(await screen.findByText('Today', {}, { timeout: 5000 })).toBeInTheDocument();
  expect(screen.getByText(currentDate)).toBeInTheDocument();
  expect(screen.getByText('Month')).toBeInTheDocument();
};

describe('Calendar', () => {
  it('basic', async () => {
    render(<App1 />);

    await assertCalendarRendered();
  });
});
