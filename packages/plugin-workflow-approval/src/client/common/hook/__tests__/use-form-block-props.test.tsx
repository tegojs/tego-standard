import { createForm } from '@tachybase/schema';
import { renderHook, waitFor } from '@tachybase/test/client';

import { vi } from 'vitest';

import { useFormBlockProps } from '../useFormBlockProps';

const mocks = vi.hoisted(() => ({
  approval: {
    id: 2667,
    status: 2,
    latestExecutionId: 3540,
    createdById: 28,
    data: { reason: 'browser regression', leaveDuration: 8 },
  },
  approvalExecution: { id: 3540 } as { id: number; approval?: any },
  currentUser: { data: { data: { id: 28 } } },
  isResubmit: true,
  form: null as ReturnType<typeof createForm> | null,
}));

vi.mock('@tachybase/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tachybase/client')>();
  return {
    ...actual,
    useCurrentUserContext: () => mocks.currentUser,
  };
});

vi.mock('@tachybase/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tachybase/schema')>();
  return {
    ...actual,
    useForm: () => mocks.form,
  };
});

vi.mock('../../contexts', () => ({
  useApproval: () => mocks.approval,
  useContextApprovalExecution: () => mocks.approvalExecution,
  useResubmit: () => ({ isResubmit: mocks.isResubmit }),
}));

describe('useFormBlockProps', () => {
  it('prefills a copied approval when the execution context has no nested approval', async () => {
    mocks.form = createForm();

    renderHook(() => useFormBlockProps());

    await waitFor(() => {
      expect(mocks.form.values).toMatchObject({
        reason: 'browser regression',
        leaveDuration: 8,
      });
      expect(mocks.form.pattern).toBe('editable');
    });
  });
});
