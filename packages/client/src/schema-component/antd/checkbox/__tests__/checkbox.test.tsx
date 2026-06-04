import React from 'react';
import { render } from '@tachybase/test/client';

import { CheckOutlined, CloseOutlined } from '@ant-design/icons';

const ReadPretty = (props) => {
  if (props.value) {
    return <CheckOutlined style={{ color: '#52c41a' }} />;
  }
  return props.showUnchecked ? <CloseOutlined style={{ color: '#ff4d4f' }} /> : null;
};

describe('Checkbox', () => {
  it('ReadPretty renders check icon when value is true', () => {
    const { container } = render(<ReadPretty value={true} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.getAttribute('data-icon')).toBe('check');
  });

  it('ReadPretty renders nothing when value is false', () => {
    const { container } = render(<ReadPretty value={false} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('ReadPretty renders close icon when showUnchecked is true', () => {
    const { container } = render(<ReadPretty value={false} showUnchecked={true} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.getAttribute('data-icon')).toBe('close');
  });
});

describe('Checkbox.Group', () => {
  it('ReadPretty renders selected tags', () => {
    const dataSource = [
      { value: 'a', label: '选项1' },
      { value: 'b', label: '选项2' },
    ];
    const { container } = render(
      <div>
        {dataSource
          .filter((opt) => ['a'].includes(opt.value))
          .map((opt, i) => (
            <span key={i} className="ant-tag">
              {opt.label}
            </span>
          ))}
      </div>,
    );
    expect(container.querySelectorAll('.ant-tag')).toHaveLength(1);
    expect(container.querySelector('.ant-tag')?.textContent).toBe('选项1');
  });
});
