import { renderHook } from '@tachybase/test/client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSubmit } from '../useSubmit';

const mocks = vi.hoisted(() => ({
  field: { data: {} as Record<string, any> },
  form: {
    initialValues: {} as Record<string, any>,
    values: {} as Record<string, any>,
    submit: vi.fn(),
  },
  update: vi.fn(),
  submitApproval: vi.fn(),
}));

vi.mock('@tachybase/client', () => ({
  useAPIClient: () => ({
    resource: (name: string) => ({
      update: mocks.update,
      submit: name === 'approvalRecords' ? mocks.submitApproval : vi.fn(),
    }),
  }),
  useCollection: () => ({ name: 'receipt' }),
  useIsMobile: () => false,
  useTableBlockContext: () => ({ service: { refresh: vi.fn() } }),
}));

vi.mock('@tachybase/module-workflow/client', () => ({
  useFlowContext: () => ({}),
}));

vi.mock('@tachybase/schema', () => ({
  useField: () => mocks.field,
  useFieldSchema: () => ({}),
  useForm: () => mocks.form,
}));

vi.mock('antd-mobile', () => ({
  Toast: { show: vi.fn() },
}));

vi.mock('../..', () => ({
  useContextApprovalAction: () => ({ status: 2 }),
  useContextApprovalExecution: () => ({}),
  useContextApprovalRecords: () => ({ id: 5974, status: 0 }),
}));

vi.mock('../useHandleRefresh', () => ({
  useHandleRefresh: () => ({ refreshTable: vi.fn() }),
}));

describe('useSubmit', () => {
  beforeEach(() => {
    mocks.field.data = {};
    mocks.update.mockReset().mockResolvedValue({ status: 200 });
    mocks.submitApproval.mockReset().mockResolvedValue({ status: 202 });
    mocks.form.submit.mockReset().mockResolvedValue(undefined);
    mocks.form.initialValues = {
      id: 70914,
      approvalId: null,
      approve_status: '0',
      account_pay: null,
      date_pay: null,
      amount_pay: null,
      comment_pay: null,
    };
    mocks.form.values = {
      ...mocks.form.initialValues,
      account_pay: { id: 746, title: 'Test account' },
      date_pay: '2026-09-30',
      amount_pay: 1,
      comment_pay: 'Test payment',
    };
  });

  it('updates only values changed in the approval form', async () => {
    const { result } = renderHook(() => useSubmit({ source: 'updateRecord' }));

    await result.current.run();

    expect(mocks.update).toHaveBeenCalledWith({
      filterByTk: 70914,
      values: {
        account_pay: { id: 746, title: 'Test account' },
        date_pay: '2026-09-30',
        amount_pay: 1,
        comment_pay: 'Test payment',
      },
    });
    expect(mocks.submitApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ data: mocks.form.values }),
      }),
    );
  });
});
