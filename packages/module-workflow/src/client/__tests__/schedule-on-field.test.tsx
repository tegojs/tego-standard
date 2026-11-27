import React, { useState } from 'react';
import { Application, DataSourceApplicationProvider } from '@tachybase/client';
import { createForm, FormProvider } from '@tachybase/schema';
import { fireEvent, render } from '@tachybase/test/client';

import { OnField } from '../triggers/schedule/OnField';

describe('schedule date-field offset editor', () => {
  it.each([
    { direction: 'Before', editedOffset: -5 },
    { direction: 'After', editedOffset: 5 },
  ])('starts a new $direction offset from zero before editing its magnitude', ({ direction, editedOffset }) => {
    const app = new Application({
      dataSourceManager: {
        collections: [
          {
            name: 'tasks',
            fields: [{ name: 'scheduledAt', type: 'date', uiSchema: { title: 'Scheduled at' } }],
          },
        ],
      },
    });
    const form = createForm({ values: { collection: 'tasks' } });
    function Editor() {
      const [value, setValue] = useState<{ field: string; offset?: number }>({ field: 'scheduledAt' });
      return (
        <>
          <OnField value={value} onChange={setValue} />
          <output aria-label="Saved date offset">{JSON.stringify(value)}</output>
        </>
      );
    }
    const { container, getByRole, getByText, getByLabelText } = render(
      <DataSourceApplicationProvider dataSourceManager={app.dataSourceManager}>
        <FormProvider form={form}>
          <Editor />
        </FormProvider>
      </DataSourceApplicationProvider>,
    );

    fireEvent.mouseDown(container.querySelectorAll('.ant-select-selector')[1]);
    fireEvent.click(getByText(direction));
    expect(JSON.parse(getByLabelText('Saved date offset').textContent)).toEqual({ field: 'scheduledAt', offset: 0 });
    expect(getByRole('spinbutton')).toHaveValue('0');
    expect(container.querySelectorAll('.ant-select-selection-item')[1]).toHaveTextContent(direction);
    fireEvent.change(getByRole('spinbutton'), { target: { value: '5' } });
    expect(JSON.parse(getByLabelText('Saved date offset').textContent)).toEqual({
      field: 'scheduledAt',
      offset: editedOffset,
    });
    expect(container.querySelectorAll('.ant-select-selection-item')[2]).toHaveTextContent('Seconds');
  });

  it.each([
    { resetKind: 'empty object', resetValue: {} },
    { resetKind: 'missing value', resetValue: undefined },
  ])('clears stale offset controls after an empty configuration reset ($resetKind)', ({ resetValue }) => {
    const app = new Application({
      dataSourceManager: {
        collections: [
          {
            name: 'tasks',
            fields: [{ name: 'scheduledAt', type: 'date', uiSchema: { title: 'Scheduled at' } }],
          },
        ],
      },
    });
    const form = createForm({ values: { collection: 'tasks' } });
    function Editor() {
      const [value, setValue] = useState<Record<string, unknown> | undefined>({
        field: 'scheduledAt',
        offset: -2,
        unit: 60000,
      });
      return (
        <>
          <button onClick={() => setValue(resetValue)}>Reset date configuration</button>
          <OnField value={value} onChange={setValue} />
          <output aria-label="Saved date offset">{JSON.stringify(value ?? null)}</output>
        </>
      );
    }
    const { container, getByRole, queryByRole, getByText, getByLabelText } = render(
      <DataSourceApplicationProvider dataSourceManager={app.dataSourceManager}>
        <FormProvider form={form}>
          <Editor />
        </FormProvider>
      </DataSourceApplicationProvider>,
    );

    expect(getByRole('spinbutton')).toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Reset date configuration' }));
    expect(JSON.parse(getByLabelText('Saved date offset').textContent)).toEqual(resetValue ?? null);
    expect(queryByRole('spinbutton')).not.toBeInTheDocument();
    fireEvent.mouseDown(container.querySelector('.ant-select-selector'));
    fireEvent.click(getByText('Scheduled at'));
    expect(JSON.parse(getByLabelText('Saved date offset').textContent)).toEqual({ field: 'scheduledAt' });
    expect(container.querySelectorAll('.ant-select-selection-item')[1]).toHaveTextContent('Exactly at');
    expect(queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it.each([
    { initialOffset: 2, nextOffset: -3, editedOffset: -5, direction: 'Before' },
    { initialOffset: -2, nextOffset: 3, editedOffset: 5, direction: 'After' },
  ])(
    'edits a loaded $direction offset using its current direction',
    ({ initialOffset, nextOffset, editedOffset, direction }) => {
      const app = new Application({
        dataSourceManager: {
          collections: [
            {
              name: 'tasks',
              fields: [{ name: 'scheduledAt', type: 'date', uiSchema: { title: 'Scheduled at' } }],
            },
          ],
        },
      });
      const form = createForm({ values: { collection: 'tasks' } });
      function Editor() {
        const [value, setValue] = useState({ field: 'scheduledAt', offset: initialOffset, unit: 60000 });
        return (
          <>
            <button onClick={() => setValue({ field: 'scheduledAt', offset: nextOffset, unit: 60000 })}>
              Load saved offset
            </button>
            <OnField value={value} onChange={setValue} />
            <output aria-label="Saved date offset">{JSON.stringify(value)}</output>
          </>
        );
      }
      const { container, getByRole, getByLabelText } = render(
        <DataSourceApplicationProvider dataSourceManager={app.dataSourceManager}>
          <FormProvider form={form}>
            <Editor />
          </FormProvider>
        </DataSourceApplicationProvider>,
      );

      fireEvent.click(getByRole('button', { name: 'Load saved offset' }));
      expect(JSON.parse(getByLabelText('Saved date offset').textContent)).toEqual({
        field: 'scheduledAt',
        offset: nextOffset,
        unit: 60000,
      });
      fireEvent.change(getByRole('spinbutton'), { target: { value: '5' } });
      expect(JSON.parse(getByLabelText('Saved date offset').textContent)).toEqual({
        field: 'scheduledAt',
        offset: editedOffset,
        unit: 60000,
      });
      expect(container.querySelectorAll('.ant-select-selection-item')[1]).toHaveTextContent(direction);
    },
  );

  it.each([
    { unit: undefined, label: 'Seconds' },
    { unit: 86400000, label: 'Days' },
    { unit: 60000, label: 'Minutes' },
  ])('shows the effective $label unit while editing an existing offset', ({ unit, label }) => {
    const app = new Application({
      dataSourceManager: {
        collections: [
          {
            name: 'tasks',
            fields: [{ name: 'scheduledAt', type: 'date', uiSchema: { title: 'Scheduled at' } }],
          },
        ],
      },
    });
    const form = createForm({ values: { collection: 'tasks' } });
    function Editor() {
      const [value, setValue] = useState({ field: 'scheduledAt', offset: 2, ...(unit ? { unit } : {}) });
      return (
        <>
          <OnField value={value} onChange={setValue} />
          <output aria-label="Saved date offset">{JSON.stringify(value)}</output>
        </>
      );
    }
    const { container, getByRole, getByLabelText } = render(
      <DataSourceApplicationProvider dataSourceManager={app.dataSourceManager}>
        <FormProvider form={form}>
          <Editor />
        </FormProvider>
      </DataSourceApplicationProvider>,
    );

    const selectedUnit = () => container.querySelectorAll('.ant-select-selection-item')[2];
    expect(selectedUnit()).toHaveTextContent(label);
    fireEvent.change(getByRole('spinbutton'), { target: { value: '5' } });
    expect(JSON.parse(getByLabelText('Saved date offset').textContent)).toEqual({
      field: 'scheduledAt',
      offset: 5,
      ...(unit ? { unit } : {}),
    });
    expect(selectedUnit()).toHaveTextContent(label);
  });
});
