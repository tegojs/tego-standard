import React from 'react';
import { fireEvent, render, renderHook, screen } from '@tachybase/test/client';

import { useAssociationFilterBlockProps, useInsertSchema } from '..';

const { state } = vi.hoisted(() => ({
  state: {
    fieldSchema: undefined as any,
    insertAfterBegin: vi.fn(),
    associationField: { name: 'parentId', target: 'parents' },
    field: { componentProps: { params: { active: true } } },
    requestRun: vi.fn(),
  },
}));

vi.mock('@tachybase/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tachybase/schema')>();
  return {
    ...actual,
    useFieldSchema: () => state.fieldSchema,
    useField: () => state.field,
  };
});

vi.mock('../..', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../..')>();
  return {
    ...actual,
    AssociationFilter: {
      ...actual.AssociationFilter,
      useAssociationField: () => state.associationField,
    },
    useDataSourceHeaders: () => ({}),
  };
});

vi.mock('../../../api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api-client')>();
  return {
    ...actual,
    useRequest: () => ({ data: { data: [] }, params: [], run: state.requestRun }),
  };
});

vi.mock('../../../collection-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../collection-manager')>();
  return {
    ...actual,
    useCollection_deprecated: () => ({ currentFields: [] }),
    useCollectionManager_deprecated: () => ({
      getCollection: () => ({ getPrimaryKey: () => 'id' }),
    }),
  };
});

vi.mock('../../../filter-provider/FilterProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../filter-provider/FilterProvider')>();
  return { ...actual, useFilterBlock: () => ({ getDataBlocks: () => [] }) };
});

vi.mock('../../BlockProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../BlockProvider')>();
  return { ...actual, useBlockRequestContext: () => ({ props: {} }) };
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

describe('useAssociationFilterBlockProps', () => {
  beforeEach(() => {
    state.fieldSchema = {
      name: 'parentId',
      interface: 'm2o',
      'x-component-props': { fieldNames: { label: 'name' } },
    };
    state.field = { componentProps: { params: { active: true } } };
    state.requestRun = vi.fn();
  });

  it('does not repeat the list request when schema identity changes without changing query inputs', () => {
    const { rerender } = renderHook(() => useAssociationFilterBlockProps());

    expect(state.requestRun).toHaveBeenCalledTimes(1);

    state.fieldSchema = { ...state.fieldSchema };
    rerender();

    expect(state.requestRun).toHaveBeenCalledTimes(1);
  });
});
