import React from 'react';
import { render } from '@tachybase/test/client';

import { MemoryRouter } from 'react-router-dom';

import App1 from '../demos/demo1';

describe('GridCard', () => {
  it('should render correctly', () => {
    render(
      <MemoryRouter>
        <App1 />
      </MemoryRouter>,
    );
  });
});
