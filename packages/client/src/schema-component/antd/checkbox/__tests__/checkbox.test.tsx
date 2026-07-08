import React from 'react';
import { render, screen, userEvent, waitFor } from '@tachybase/test/client';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { Checkbox } from '../Checkbox';

const FormItem = ({ children }) => <>{children}</>;

describe('Checkbox', () => {
  it('ReadPretty renders check icon when value is true', () => {
    const { container } = render(<Checkbox.ReadPretty value={true} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.getAttribute('data-icon')).toBe('check');
  });

  it('ReadPretty renders nothing when value is false', () => {
    const { container } = render(<Checkbox.ReadPretty value={false} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('ReadPretty renders close icon when showUnchecked is true', () => {
    const { container } = render(<Checkbox.ReadPretty value={false} showUnchecked={true} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.getAttribute('data-icon')).toBe('close');
  });
});

describe('Checkbox.Group', () => {
  it('renders selected tags in read-pretty mode', async () => {
    const schema = {
      type: 'object',
      properties: {
        input: {
          type: 'array',
          enum: [
            { value: 'a', label: '选项1' },
            { value: 'b', label: '选项2' },
          ],
          'x-decorator': 'FormItem',
          'x-component': 'Checkbox.Group',
          'x-reactions': {
            target: 'read',
            fulfill: {
              state: {
                value: '{{$self.value}}',
              },
            },
          },
        },
        read: {
          type: 'array',
          enum: [
            { value: 'a', label: '选项1' },
            { value: 'b', label: '选项2' },
          ],
          'x-read-pretty': true,
          'x-decorator': 'FormItem',
          'x-component': 'Checkbox.Group',
        },
      },
    };

    const { container } = render(
      <SchemaComponentProvider components={{ Checkbox, FormItem }}>
        <SchemaComponent schema={schema} />
      </SchemaComponentProvider>,
    );

    await userEvent.click(screen.getByLabelText('选项1'));

    await waitFor(() => {
      expect(container.querySelectorAll('.ant-tag')).toHaveLength(1);
    });
    expect(container.querySelector('.ant-tag')?.textContent).toBe('选项1');
  });
});
