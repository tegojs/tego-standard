import React from 'react';
import { fireEvent, render, screen } from '@tachybase/test/client';

import App from '../demos/demo1';

describe('ColorSelect', () => {
  it('should display the value of user selected', async () => {
    const { container } = render(<App />);

    const selector = container.querySelector('.ant-select-selector');
    fireEvent.mouseDown(selector);
    expect(screen.getByText('Red')).toBeInTheDocument();

    expect(screen.getByText('Magenta')).toBeInTheDocument();

    expect(screen.getByText('Volcano')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Red'));
    expect(container.querySelector('.ant-select-selection-item')).toHaveTextContent('Red');
    expect(container.querySelector('.ant-tag-red')).toHaveTextContent('Red');
  });
});
