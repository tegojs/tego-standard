import React from 'react';
import { action, ArrayField, useField } from '@tachybase/schema';
import { fireEvent, render, screen, userEvent, waitFor } from '@tachybase/test/client';

import { SchemaComponent } from '../../../core/SchemaComponent';
import { SchemaComponentProvider } from '../../../core/SchemaComponentProvider';
import { Cascader } from '../Cascader';

const FormItem = ({ children }) => <>{children}</>;

const options = [
  {
    value: 'zhejiang',
    label: 'Zhejiang',
    children: [
      {
        value: 'hangzhou',
        label: 'Hangzhou',
        children: [{ value: 'xihu', label: 'West Lake' }],
      },
    ],
  },
];

const createSchema = (componentProps = {}, extraReactions: unknown[] = []) => {
  const syncReadPrettyReaction = {
    target: 'read',
    fulfill: {
      state: {
        value: '{{$self.value}}',
      },
    },
  };

  return {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        enum: options,
        'x-decorator': 'FormItem',
        'x-component': 'Cascader',
        'x-component-props': componentProps,
        'x-reactions': extraReactions.length ? [...extraReactions, syncReadPrettyReaction] : syncReadPrettyReaction,
      },
      read: {
        type: 'string',
        enum: options,
        'x-read-pretty': true,
        'x-decorator': 'FormItem',
        'x-component': 'Cascader',
        'x-component-props': componentProps,
      },
    },
  };
};

const renderCascader = (schema) =>
  render(
    <SchemaComponentProvider components={{ Cascader, FormItem }}>
      <SchemaComponent schema={schema} />
    </SchemaComponentProvider>,
  );

const useAsyncDataSource = (field: ArrayField) => {
  field.loading = true;
  Promise.resolve(options).then(
    action.bound((data) => {
      field.dataSource = data;
      field.loading = false;
    }),
  );
};

const useLoadData = () => {
  const field = useField<ArrayField>();
  return (selectedOptions) => {
    const targetOption = selectedOptions[selectedOptions.length - 1];
    targetOption.loading = true;
    setTimeout(() => {
      targetOption.loading = false;
      targetOption.children = [
        {
          label: `${targetOption.label} Dynamic 1`,
          value: 'dynamic1',
        },
      ];
      field.dataSource = [...field.dataSource];
    }, 10);
  };
};

describe('Cascader', () => {
  it('renders selected sync option in read pretty mode', async () => {
    const { container } = renderCascader(createSchema());

    await userEvent.click(container.querySelector('.ant-select-selector') as HTMLElement);

    fireEvent.click(await screen.findByText('Zhejiang'));
    fireEvent.click(screen.getByText('Hangzhou'));
    fireEvent.click(screen.getByText('West Lake'));

    expect(await screen.findByText('Zhejiang /')).toBeInTheDocument();
    expect(screen.getByText('Hangzhou /')).toBeInTheDocument();
  });

  it('loads async options before rendering selected value', async () => {
    const schema = createSchema(
      {
        changeOnSelectLast: false,
        labelInValue: true,
        maxLevel: 3,
        useLoadData: '{{useLoadData}}',
      },
      [
        {
          dependencies: [],
          fulfill: {
            run: '{{useAsyncDataSource($self)}}',
          },
        },
      ],
    );
    const { container } = render(
      <SchemaComponentProvider components={{ Cascader, FormItem }}>
        <SchemaComponent scope={{ useAsyncDataSource, useLoadData }} schema={schema} />
      </SchemaComponentProvider>,
    );

    await userEvent.click(container.querySelector('.ant-select-selector') as HTMLElement);
    fireEvent.click(await screen.findByText('Zhejiang'));

    expect(screen.queryByText('Zhejiang Dynamic 1')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText('Zhejiang Dynamic 1'));

    await waitFor(() => {
      expect(screen.getByText('Zhejiang /')).toBeInTheDocument();
    });
  });
});
