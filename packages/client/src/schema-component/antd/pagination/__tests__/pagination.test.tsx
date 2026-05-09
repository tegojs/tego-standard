import React from 'react';
import { render } from '@tachybase/test/client';

import { Pagination } from '..';
import { shouldAutoEnableQuickJumper, withAutoQuickJumper } from '../utils';

describe('Pagination', () => {
  it('enables quick jumper only after pagination enters ellipsis mode', () => {
    expect(shouldAutoEnableQuickJumper({ total: 70, pageSize: 10 })).toBe(false);
    expect(shouldAutoEnableQuickJumper({ total: 80, pageSize: 10 })).toBe(true);
  });

  it('does not auto enable quick jumper for simple pagination', () => {
    expect(shouldAutoEnableQuickJumper({ total: 80, pageSize: 10, simple: true })).toBe(false);
  });

  it('does not override explicit quick jumper config', () => {
    expect(withAutoQuickJumper({ total: 80, pageSize: 10, showQuickJumper: false })).toEqual({
      total: 80,
      pageSize: 10,
      showQuickJumper: false,
    });
  });

  it('shows quick jumper when pagination enters ellipsis mode', () => {
    const { container } = render(<Pagination current={1} total={80} pageSize={10} />);

    expect(container.querySelector('.ant-pagination-options-quick-jumper')).not.toBeNull();
  });

  it('does not show quick jumper when total pages do not enter ellipsis mode', () => {
    const { container } = render(<Pagination current={1} total={70} pageSize={10} />);

    expect(container.querySelector('.ant-pagination-options-quick-jumper')).toBeNull();
  });

  it('does not force quick jumper for simple pagination', () => {
    const { container } = render(<Pagination current={1} total={80} pageSize={10} simple />);

    expect(container.querySelector('.ant-pagination-options-quick-jumper')).toBeNull();
  });

  it('respects explicit quick jumper config', () => {
    const { container } = render(<Pagination current={1} total={70} pageSize={10} showQuickJumper />);

    expect(container.querySelector('.ant-pagination-options-quick-jumper')).not.toBeNull();
  });
});
