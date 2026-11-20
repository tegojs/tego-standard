import React from 'react';
import { fireEvent, render, screen } from '@tachybase/test/client';

import { useInsertSchema } from '..';

const { state } = vi.hoisted(() => ({
  state: {
    fieldSchema: undefined as any,
    insertAfterBegin: vi.fn(),
  },
}));

vi.mock('@tachybase/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tachybase/schema')>();
  return {
    ...actual,
    useFieldSchema: () => state.fieldSchema,
  };
});

vi.mock('../../../schema-component', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../schema-component')>();
  return {
    ...actual,
    useDesignable: () => ({ insertAfterBegin: state.insertAfterBegin }),
  };
});

function InsertProbe() {
  const insert = useInsertSchema();
  return <button onClick={() => insert({ type: 'void', name: 'new-field' })}>Insert</button>;
}

describe('useInsertSchema', () => {
  it('uses the current schema before inserting after schema context changes', () => {
    const firstSchema = { reduceProperties: vi.fn(() => null) };
    state.fieldSchema = firstSchema;
    state.insertAfterBegin = vi.fn();
    const firstInsert = state.insertAfterBegin;
    const { rerender } = render(<InsertProbe />);

    const currentSchema = {
      reduceProperties: vi.fn(() => ({ 'x-component': 'Action.Container' })),
    };
    const currentInsert = vi.fn();
    state.fieldSchema = currentSchema;
    state.insertAfterBegin = currentInsert;
    rerender(<InsertProbe />);

    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));

    expect(firstSchema.reduceProperties).not.toHaveBeenCalled();
    expect(currentSchema.reduceProperties).toHaveBeenCalledOnce();
    expect(firstInsert).not.toHaveBeenCalled();
    expect(currentInsert).not.toHaveBeenCalled();
  });
});
