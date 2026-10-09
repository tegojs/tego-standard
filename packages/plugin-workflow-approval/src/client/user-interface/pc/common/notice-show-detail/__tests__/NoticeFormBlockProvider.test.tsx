import React from 'react';
import { FlowContext } from '@tachybase/module-workflow/client';
import { render, screen } from '@tachybase/test/client';

import { vi } from 'vitest';

import { ProviderContextWorkflowNotice } from '../contexts/WorkflowNotice.context';
import { NoticeFormBlockProvider } from '../NoticeFormBlockProvider';

vi.mock('@tachybase/client', () => ({
  FormBlockProvider: () => <div>Data source form</div>,
}));

vi.mock('@tachybase/module-workflow/client', async () => {
  const { createContext, useContext } = await import('react');
  const FlowContext = createContext<any>({});
  return {
    FlowContext,
    useFlowContext: () => useContext(FlowContext),
    DetailsBlockProvider: () => {
      const { execution } = useContext(FlowContext);
      return <output>{JSON.stringify(execution.context.data)}</output>;
    },
  };
});

describe('carbon copy trigger data block', () => {
  it('seeds the whole block with snapshot values and saved matching associations', () => {
    const snapshot = { id: 70925, items_amount_pay: 1 };
    const data = { id: 70925, items_amount_pay: 9, accountItemList: [{ money: 1 }] };
    render(
      <FlowContext.Provider value={{ execution: { context: { collectionName: 'receipt', data } } }}>
        <ProviderContextWorkflowNotice value={{ collectionName: 'receipt', snapshot }}>
          <NoticeFormBlockProvider collection="receipt" dataSource="main" />
        </ProviderContextWorkflowNotice>
      </FlowContext.Provider>,
    );

    expect(screen.getByRole('status').textContent).toBe(JSON.stringify({ ...data, ...snapshot }));
  });

  it('does not seed associations from another record before the snapshot is applied', () => {
    const snapshot = { id: 70925, items_amount_pay: 1 };
    render(
      <FlowContext.Provider
        value={{ execution: { context: { collectionName: 'receipt', data: { id: 4055, items: [{ money: 34189 }] } } } }}
      >
        <ProviderContextWorkflowNotice value={{ collectionName: 'receipt', snapshot }}>
          <NoticeFormBlockProvider collection="receipt" dataSource="main" />
        </ProviderContextWorkflowNotice>
      </FlowContext.Provider>,
    );

    expect(screen.getByRole('status').textContent).toBe(JSON.stringify(snapshot));
  });

  it.each([
    { collection: 'other', dataSource: 'main' },
    { collection: 'receipt', dataSource: 'external' },
  ])('preserves ordinary data blocks outside the trigger collection: %s', (props) => {
    render(
      <ProviderContextWorkflowNotice value={{ collectionName: 'receipt' }}>
        <NoticeFormBlockProvider {...props} />
      </ProviderContextWorkflowNotice>,
    );

    expect(screen.getByText('Data source form')).toBeInTheDocument();
  });
});
