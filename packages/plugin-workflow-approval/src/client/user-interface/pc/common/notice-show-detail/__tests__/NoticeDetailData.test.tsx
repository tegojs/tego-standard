import React from 'react';
import { render, screen } from '@tachybase/test/client';

import { vi } from 'vitest';

import { ProviderContextWorkflowNotice } from '../contexts/WorkflowNotice.context';
import { NoticeDetailData } from '../NoticeDetailData';

vi.mock('@tachybase/client', async () => {
  const { useMemo } = await import('react');
  return {
    RemoteSchemaComponent: ({ uid }) => <div>Custom detail: {uid}</div>,
    useCompile: () => (value) => value,
    useOptimizedMemo: useMemo,
    useCollectionManager: () => ({ getCollectionField: () => undefined }),
  };
});

vi.mock('../../../../../locale', () => ({
  useTranslation: () => ({ t: (value) => value }),
}));

const summary = [
  { key: 'items_amount_pay', type: 'literal', label: 'Payment total', value: 30000 },
  {
    key: 'accountItemList',
    type: 'table',
    label: 'Payment items',
    value: [
      { key: 'accounts', type: 'array', label: 'Account', value: ['Salary', 'Salary'] },
      { key: 'money', type: 'array', label: 'Amount', value: [15000, 15000] },
    ],
  },
];

describe('carbon copy detail data', () => {
  it('renders the saved total and line items when the execution was removed', () => {
    render(
      <ProviderContextWorkflowNotice value={{ execution: null, summary, snapshot: { items_amount_pay: 30000 } }}>
        <NoticeDetailData uid="custom-detail" />
      </ProviderContextWorkflowNotice>,
    );

    expect(screen.getByText('30000')).toBeInTheDocument();
    expect(screen.getAllByText('15000')).toHaveLength(2);
    expect(screen.getAllByText('Salary')).toHaveLength(2);
    expect(screen.queryByText('Custom detail: custom-detail')).not.toBeInTheDocument();
  });

  it('keeps the configured detail when its execution still exists', () => {
    render(
      <ProviderContextWorkflowNotice value={{ execution: { id: 10 }, summary }}>
        <NoticeDetailData uid="custom-detail" />
      </ProviderContextWorkflowNotice>,
    );

    expect(screen.getByText('Custom detail: custom-detail')).toBeInTheDocument();
  });

  it('renders a legacy object summary without converting a zero total into an empty value', () => {
    render(
      <ProviderContextWorkflowNotice value={{ execution: null, summary: { amount: 0 } }}>
        <NoticeDetailData uid="custom-detail" />
      </ProviderContextWorkflowNotice>,
    );

    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('Custom detail: custom-detail')).not.toBeInTheDocument();
  });

  it.each([undefined, null, [], {}])('keeps the snapshot detail when there is no saved summary: %s', (value) => {
    render(
      <ProviderContextWorkflowNotice value={{ execution: null, summary: value }}>
        <NoticeDetailData uid="custom-detail" />
      </ProviderContextWorkflowNotice>,
    );

    expect(screen.getByText('Custom detail: custom-detail')).toBeInTheDocument();
  });
});
