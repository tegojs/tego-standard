import React from 'react';
import { fireEvent, render, screen, userEvent, waitFor } from '@tachybase/test/client';

import App1 from '../demos/demo1';
import App2 from '../demos/demo2';
import App3 from '../demos/demo3';
import App4 from '../demos/demo4';

// In jsdom, antd Drawer/Modal animations never complete (no CSS engine),
// so the DOM element persists after close. Check for the open state class instead.
const drawerIsOpen = () => document.querySelector('.ant-drawer-open') !== null;
const modalIsOpen = () => document.querySelector('.ant-modal-wrap') !== null;

describe('Action', () => {
  it('show the drawer when click the button', async () => {
    const { getByText } = render(<App1 />);

    await userEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(drawerIsOpen()).toBe(true);
    });
    // mask
    expect(document.querySelector('.ant-drawer-mask')).toBeInTheDocument();
    // title
    expect(getByText('Drawer Title')).toBeInTheDocument();
    // content
    expect(getByText('Hello')).toBeInTheDocument();

    // close button
    await userEvent.click(getByText('Close'));
    await waitFor(() => {
      expect(drawerIsOpen()).toBe(false);
    });

    // should also close when click the mask
    await userEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(drawerIsOpen()).toBe(true);
    });
    await userEvent.click(document.querySelector('.ant-drawer-mask') as HTMLElement);
    await waitFor(() => {
      expect(drawerIsOpen()).toBe(false);
    });

    // should also close when click the close icon
    await userEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(drawerIsOpen()).toBe(true);
    });
    await userEvent.click(document.querySelector('.ant-drawer-close') as HTMLElement);
    await waitFor(() => {
      expect(drawerIsOpen()).toBe(false);
    });
  });

  it('openMode', async () => {
    const { getByText } = render(<App3 />);

    expect(drawerIsOpen()).toBe(false);
    expect(document.querySelector('.ant-modal')).not.toBeInTheDocument();
    expect(document.querySelector('.tb-action-page')).not.toBeInTheDocument();

    // drawer
    await userEvent.click(getByText('Drawer'));
    await userEvent.click(getByText('Open'));

    await waitFor(() => {
      expect(drawerIsOpen()).toBe(true);
      expect(document.querySelector('.ant-modal')).not.toBeInTheDocument();
      expect(document.querySelector('.tb-action-page')).not.toBeInTheDocument();
    });

    await userEvent.click(getByText('Close'));

    // modal
    await userEvent.click(getByText('Modal'));
    await userEvent.click(getByText('Open'));

    await waitFor(() => {
      expect(drawerIsOpen()).toBe(false);
      expect(document.querySelector('.ant-modal')).toBeInTheDocument();
      expect(document.querySelector('.tb-action-page')).not.toBeInTheDocument();
    });

    await userEvent.click(getByText('Close'));

    // page
    await userEvent.click(getByText('Page'));
    await userEvent.click(getByText('Open'));

    await waitFor(() => {
      expect(drawerIsOpen()).toBe(false);
      expect(document.querySelector('.ant-modal')).not.toBeInTheDocument();
      expect(document.querySelector('.tb-action-page')).toBeInTheDocument();
    });
    await userEvent.click(getByText('Close'));

    // TODO: 点击关闭按钮时应该消失
    // expect(document.querySelector('.tb-action-page')).not.toBeInTheDocument();
  });
});

describe('Action.Drawer without Action', () => {
  it('show the drawer when click the button', async () => {
    const { getByText } = render(<App2 />);

    await userEvent.click(getByText('Open'));
    await waitFor(() => {
      // drawer
      expect(drawerIsOpen()).toBe(true);
      // mask
      expect(document.querySelector('.ant-drawer-mask')).toBeInTheDocument();
      // title
      expect(getByText('Drawer Title')).toBeInTheDocument();
      // content
      expect(getByText('Hello')).toBeInTheDocument();
    });

    // close button
    await userEvent.click(getByText('Close'));
    await waitFor(() => {
      expect(drawerIsOpen()).toBe(false);
    });

    // should also close when click the mask
    await userEvent.click(getByText('Open'));
    await waitFor(() => {
      expect(drawerIsOpen()).toBe(true);
    });
    await userEvent.click(document.querySelector('.ant-drawer-mask') as HTMLElement);
    await waitFor(() => {
      expect(drawerIsOpen()).toBe(false);
    });

    // should also close when click the close icon
    await userEvent.click(getByText('Open'));

    await waitFor(() => {
      expect(drawerIsOpen()).toBe(true);
    });

    await userEvent.click(document.querySelector('.ant-drawer-close') as HTMLElement);

    await waitFor(() => {
      expect(drawerIsOpen()).toBe(false);
    });
  });
});

describe('Action.Popover', () => {
  it('show the popover when hover the button', async () => {
    const { container } = render(<App4 />);
    const btn = container.querySelector('.ant-btn') as HTMLElement;

    fireEvent.mouseEnter(btn);

    await waitFor(() => {
      // popover
      expect(document.querySelector('.ant-popover')).toBeInTheDocument();
      // content
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });

    fireEvent.mouseLeave(btn);
    await waitFor(() => {
      expect(document.querySelector('.ant-popover')).not.toBeInTheDocument();
    });
  });
});
