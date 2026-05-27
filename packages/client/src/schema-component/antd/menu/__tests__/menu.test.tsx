import React from 'react';
import { fireEvent, render, screen, userEvent, waitFor, within } from '@tachybase/test/client';

import App1 from '../demos/demo1';
import App2 from '../demos/demo2';
import App3 from '../demos/demo3';

const openHeaderMenu = async () => {
  fireEvent.mouseEnter(document.querySelector('.iconButton') as HTMLElement);
  await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());
  return screen.getByRole('tooltip');
};

describe('Menu', () => {
  it('mode: "horizontal"', async () => {
    render(<App1 />);

    const tooltip = await openHeaderMenu();
    expect(within(tooltip).getByText(/menu item 1/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/menu item 2/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/submenu 1/i)).toBeInTheDocument();

    await userEvent.click(within(tooltip).getByText(/menu item 2/i));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('mode: "inline"', async () => {
    render(<App2 />);

    const tooltip = await openHeaderMenu();
    expect(within(tooltip).getByText(/menu item 1/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/menu item 2/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/submenu 1/i)).toBeInTheDocument();

    await userEvent.click(within(tooltip).getByText(/menu item 2/i));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('mode: "mix"', async () => {
    render(<App3 />);

    const tooltip = await openHeaderMenu();
    expect(within(tooltip).getByText(/menu item 1/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/menu item 2/i)).toBeInTheDocument();
    expect(within(tooltip).getByText(/submenu 1/i)).toBeInTheDocument();

    await userEvent.click(within(tooltip).getByText(/menu item 2/i));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });
});
