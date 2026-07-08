import React from 'react';
import { render } from '@tachybase/test/client';

import App1 from '../demos/demo1';

describe('Details', () => {
  it('should render correctly', () => {
    const { container } = render(<App1 />);

    expect(container.querySelector('.ant-empty-description')).toHaveTextContent('No data');
  });
});
