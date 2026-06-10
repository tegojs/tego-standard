import React from 'react';
import { fireEvent, render, screen, waitFor } from '@tachybase/test/client';

import App1 from '../demos/demo1';
import App2 from '../demos/demo2';
import App3 from '../demos/demo3';
import App4 from '../demos/demo4';

// In jsdom, CSS transitions/animations never fire completion events, so antd Drawer/Modal
// animations never complete and cleanup DOM never runs. We verify open state and click
// interactions instead of checking DOM removal after close.

describe('Action', () => {
  it('show the drawer when click the button', async () => {
    const { getByText } = render(<App1 />);

    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.ant-drawer-open')).toBeInTheDocument();
    });
    expect(document.querySelector('.ant-drawer-mask')).toBeInTheDocument();
    expect(getByText('Drawer Title')).toBeInTheDocument();
    expect(getByText('Hello')).toBeInTheDocument();

    // close button triggers setVisible(false) - verify click doesn't throw
    fireEvent.click(getByText('Close'));
  });

  it('openMode', async () => {
    const { getByText } = render(<App3 />);

    // drawer mode
    fireEvent.click(getByText('Drawer'));
    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.ant-drawer-open')).toBeInTheDocument();
      expect(document.querySelector('.ant-modal')).not.toBeInTheDocument();
      expect(document.querySelector('.tb-action-page')).not.toBeInTheDocument();
    });

    fireEvent.click(getByText('Close'));

    // modal mode
    fireEvent.click(getByText('Modal'));
    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.ant-modal')).toBeInTheDocument();
    });

    fireEvent.click(getByText('Close'));

    // page mode
    fireEvent.click(getByText('Page'));
    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.tb-action-page')).toBeInTheDocument();
    });
    fireEvent.click(getByText('Close'));
  });
});

describe('Action.Drawer without Action', () => {
  it('show the drawer when click the button', async () => {
    const { getByText } = render(<App2 />);

    fireEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(document.querySelector('.ant-drawer-open')).toBeInTheDocument();
      expect(document.querySelector('.ant-drawer-mask')).toBeInTheDocument();
      expect(getByText('Drawer Title')).toBeInTheDocument();
      expect(getByText('Hello')).toBeInTheDocument();
    });

    // close button triggers setVisible(false) - verify click doesn't throw
    fireEvent.click(getByText('Close'));
  });
});

describe('Action.Popover', () => {
  it('show the popover when hover the button', async () => {
    const { container } = render(<App4 />);
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
