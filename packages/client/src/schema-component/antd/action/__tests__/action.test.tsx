import React from 'react';
import { fireEvent, render, screen, waitFor } from '@tachybase/test/client';

import { MemoryRouter } from 'react-router-dom';

import App1 from '../demos/demo1';
import App2 from '../demos/demo2';
import App3 from '../demos/demo3';
import App4 from '../demos/demo4';

// In jsdom, CSS transitions/animations never fire completion events, so antd Drawer/Modal
// animations never complete and cleanup DOM may not run. Assert the open state instead
// of requiring the animated wrapper to be removed from the DOM.

function renderWithRouter(children: React.ReactElement) {
  return render(<MemoryRouter>{children}</MemoryRouter>);
}

async function expectDrawerClosed() {
  await waitFor(() => {
    expect(document.querySelector('.ant-drawer-open')).not.toBeInTheDocument();
  });
}

describe('Action', () => {
  it('show the drawer when click the button', async () => {
    const { getByText } = renderWithRouter(<App1 />);

    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.ant-drawer-open')).toBeInTheDocument();
    });
    expect(document.querySelector('.ant-drawer-mask')).toBeInTheDocument();
    expect(getByText('Drawer Title')).toBeInTheDocument();
    expect(getByText('Hello')).toBeInTheDocument();

    fireEvent.click(getByText('Close'));
    await expectDrawerClosed();

    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.ant-drawer-open')).toBeInTheDocument();
    });
    fireEvent.click(document.querySelector('.ant-drawer-mask') as HTMLElement);
    await expectDrawerClosed();
  });

  it('openMode', async () => {
    const { getByText } = renderWithRouter(<App3 />);

    // drawer mode
    fireEvent.click(getByText('Drawer'));
    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.ant-drawer-open')).toBeInTheDocument();
      expect(document.querySelector('.ant-modal')).not.toBeInTheDocument();
      expect(document.querySelector('.tb-action-page')).not.toBeInTheDocument();
    });

    fireEvent.click(getByText('Close'));
    await expectDrawerClosed();

    // modal mode
    fireEvent.click(getByText('Modal'));
    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.ant-modal')).toBeInTheDocument();
    });

    fireEvent.click(getByText('Close'));
    await waitFor(() => {
      expect(document.querySelector('.ant-modal')).not.toBeInTheDocument();
    });

    // page mode
    fireEvent.click(getByText('Page'));
    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.tb-action-page')).toBeInTheDocument();
    });
  });
});

describe('Action.Drawer without Action', () => {
  it('show the drawer when click the button', async () => {
    const { getByText } = renderWithRouter(<App2 />);

    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.ant-drawer-open')).toBeInTheDocument();
      expect(document.querySelector('.ant-drawer-mask')).toBeInTheDocument();
      expect(getByText('Drawer Title')).toBeInTheDocument();
      expect(getByText('Hello')).toBeInTheDocument();
    });

    fireEvent.click(getByText('Close'));
    await expectDrawerClosed();

    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.ant-drawer-open')).toBeInTheDocument();
    });
    fireEvent.click(document.querySelector('.ant-drawer-mask') as HTMLElement);
    await expectDrawerClosed();
  });
});

describe('Action.Popover', () => {
  it('show the popover when hover the button', async () => {
    const { container } = renderWithRouter(<App4 />);
    const btn = container.querySelector('.ant-btn') as HTMLElement;

    fireEvent.mouseEnter(btn);

    await waitFor(() => {
      expect(document.querySelector('.ant-popover')).toBeInTheDocument();
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });

    fireEvent.mouseLeave(btn);
    await waitFor(() => {
      expect(document.querySelector('.ant-popover')).not.toBeInTheDocument();
    });
  });
});
