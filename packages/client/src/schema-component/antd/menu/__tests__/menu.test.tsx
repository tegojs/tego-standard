import React from 'react';
import { render, screen, userEvent, waitFor } from '@tachybase/test/client';

import App1 from '../demos/demo1';
import App2 from '../demos/demo2';
import App3 from '../demos/demo3';

describe('Menu', () => {
  const openAdminMenu = async () => {
    await userEvent.click(await screen.findByRole('button'));
    return screen.findByText(/menu item 1/i);
  };

  it('mode: "horizontal"', async () => {
    render(<App1 />);

    await openAdminMenu();

    await waitFor(() => {
      expect(screen.getByText(/menu item 1/i)).toBeInTheDocument();
      expect(screen.getByText(/menu item 2/i)).toBeInTheDocument();
      expect(screen.getByText(/submenu 1/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/menu item 2/i));
  });

  it('mode: "inline"', async () => {
    render(<App2 />);

    await openAdminMenu();

    await waitFor(() => {
      expect(screen.getByText(/menu item 1/i)).toBeInTheDocument();
      expect(screen.getByText(/menu item 2/i)).toBeInTheDocument();
      expect(screen.getByText(/submenu 1/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/menu item 2/i));
  });

  it('mode: "mix"', async () => {
    render(<App3 />);

    await openAdminMenu();

    await waitFor(() => {
      expect(screen.getByText(/menu item 1/i)).toBeInTheDocument();
      expect(screen.getByText(/menu item 2/i)).toBeInTheDocument();
      expect(screen.getByText(/submenu 1/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/menu item 2/i));
  });
});
