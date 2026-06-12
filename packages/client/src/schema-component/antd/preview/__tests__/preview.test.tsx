import React from 'react';
import { render } from '@tachybase/test/client';

import App1 from '../demos/demo1';

describe('Preview', () => {
  it('should render correctly', () => {
    const { container, queryAllByText } = render(<App1 />);

    expect(container.querySelectorAll('.ant-upload-list-item')).toHaveLength(3);
    expect(queryAllByText('s33766399')).toHaveLength(2);
    expect(queryAllByText('简历')).toHaveLength(1);
  });
});
