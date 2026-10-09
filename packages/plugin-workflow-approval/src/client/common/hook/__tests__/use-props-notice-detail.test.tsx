import { createForm } from '@tachybase/schema';
import { renderHook } from '@tachybase/test/client';

import { vi } from 'vitest';

import { usePropsNoticeDetail } from '../usePropsNoticeDetail';

const mocks = vi.hoisted(() => ({ form: null as any, notice: {} as any }));

vi.mock('@tachybase/client', () => ({
  useFormBlockContext: () => ({ form: mocks.form }),
}));

vi.mock('../../../user-interface/pc/common/notice-show-detail/contexts/WorkflowNotice.context', () => ({
  useContexWorkflowNotice: () => mocks.notice,
}));

describe('carbon copy snapshot form values', () => {
  beforeEach(() => {
    mocks.form = createForm();
  });

  it('retains saved execution associations alongside the carbon copy snapshot values', () => {
    const accountItemList = [{ id: 77216, money: 1, accounts: { id: 19, name: 'Freight' } }];
    mocks.notice = {
      collectionName: 'receipt',
      snapshot: { id: 70925, items_amount_pay: 1, reason: 'Copied reason' },
      execution: {
        context: {
          collectionName: 'receipt',
          data: { id: 70925, reason: 'Original reason', accountItemList },
        },
      },
    };

    renderHook(() => usePropsNoticeDetail());

    expect(mocks.form.values).toMatchObject({
      id: 70925,
      reason: 'Copied reason',
      items_amount_pay: 1,
      accountItemList,
    });
  });

  it('uses only the copied snapshot when no execution is available', () => {
    mocks.notice = { snapshot: { id: 70910, items_amount_pay: 30000 } };

    renderHook(() => usePropsNoticeDetail());

    expect(mocks.form.values).toEqual(mocks.notice.snapshot);
  });

  it('does not mix a snapshot with trigger data for another record', () => {
    mocks.notice = {
      collectionName: 'receipt',
      snapshot: { id: 70925, items_amount_pay: 1 },
      execution: { context: { collectionName: 'receipt', data: { id: 4055, accountItemList: [{ money: 34189 }] } } },
    };

    renderHook(() => usePropsNoticeDetail());

    expect(mocks.form.values).toEqual(mocks.notice.snapshot);
  });

  it('does not mix records from different collections with the same id', () => {
    mocks.notice = {
      collectionName: 'receipt',
      snapshot: { id: 10, items_amount_pay: 1 },
      execution: { context: { collectionName: 'other', data: { id: 10, items: [{ money: 9 }] } } },
    };

    renderHook(() => usePropsNoticeDetail());

    expect(mocks.form.values).toEqual(mocks.notice.snapshot);
  });

  it('preserves explicit empty associations and zero amounts in the copied snapshot', () => {
    mocks.notice = {
      collectionName: 'receipt',
      snapshot: { id: 10, items_amount_pay: 0, accountItemList: [], company_pay: null },
      execution: {
        context: {
          collectionName: 'receipt',
          data: { id: 10, items_amount_pay: 9, accountItemList: [{ money: 9 }], company_pay: { id: 1 } },
        },
      },
    };

    renderHook(() => usePropsNoticeDetail());

    expect(mocks.form.values).toEqual(mocks.notice.snapshot);
  });
});
