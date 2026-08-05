import { createForm } from '@tachybase/schema';
import { renderHook } from '@tachybase/test/client';

import { beforeEach, vi } from 'vitest';

import { useSubmitCreate } from '../useSubmitCreate';

const mocks = vi.hoisted(() => ({
  configuredPaths: [] as string[],
  create: vi.fn(),
  field: { data: {} },
  flowContext: { workflow: { id: 1304, key: 'approval-copy' } },
  form: null as ReturnType<typeof createForm> | null,
  notification: { error: vi.fn() },
}));

vi.mock('@tachybase/client', () => ({
  joinCollectionName: (dataSource: string, collection: string) => `${dataSource}:${collection}`,
  useActionContext: () => ({}),
  useAPIClient: () => ({
    notification: mocks.notification,
    resource: () => ({ create: mocks.create }),
  }),
  useBlockRequestContext: () => ({}),
  useCollection_deprecated: () => ({ dataSource: 'main', name: 'receipt' }),
  useFormBlockContext: () => ({ updateAssociationValues: mocks.configuredPaths }),
  useIsMobile: () => false,
}));

vi.mock('@tachybase/module-workflow/client', () => ({
  useFlowContext: () => mocks.flowContext,
}));

vi.mock('@tachybase/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tachybase/schema')>();
  return {
    ...actual,
    useField: () => mocks.field,
    useForm: () => mocks.form,
  };
});

vi.mock('antd-mobile', () => ({
  Toast: { show: vi.fn() },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock('../..', () => ({
  useContextApprovalExecution: () => ({}),
  useQuickCreate: () => ({ isQuickCreate: true }),
  useResubmit: () => ({ isResubmit: false }),
}));

vi.mock('../../../user-interface/pc/block/common/providers/ActionStatus.provider', () => ({
  useContextApprovalStatus: () => 1,
}));

describe('useSubmitCreate', () => {
  beforeEach(() => {
    mocks.configuredPaths = [];
    mocks.create.mockReset().mockResolvedValue({ status: 200 });
    mocks.notification.error.mockReset();
    mocks.field.data = {};
    mocks.flowContext = { workflow: { id: 1304, key: 'approval-copy' } };
    mocks.form = createForm({
      values: {
        accountItemList: [{ id: 73954, amount: 13579 }],
      },
    });
  });

  it('sends a dynamically rendered SubTable as a copy association', async () => {
    mocks.form.createArrayField({
      name: 'accountItemList',
      component: ['CollectionField', { mode: 'SubTable' }],
    });

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.create).toHaveBeenCalledWith({
      values: expect.objectContaining({
        isCopy: true,
        copyAssociationValues: ['accountItemList'],
      }),
    });
  });

  it('normalizes nested array fields and merges configured copy associations', async () => {
    mocks.configuredPaths = ['configuredDetails', 'accountItemList'];
    mocks.form.createArrayField({
      name: 'accountItemList',
      component: ['CollectionField', { mode: 'SubTable' }],
    });
    mocks.form.createArrayField({
      basePath: 'accountItemList.0',
      name: 'subdetails',
      component: ['CollectionField', { mode: 'Nester' }],
    });
    mocks.form.createArrayField({
      basePath: 'accountItemList.1',
      name: 'subdetails',
      component: ['CollectionField', { mode: 'Nester' }],
    });
    mocks.form.createField({
      name: 'sharedTag',
      component: ['CollectionField', { mode: 'Select' }],
    });

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.create).toHaveBeenCalledWith({
      values: expect.objectContaining({
        copyAssociationValues: ['configuredDetails', 'accountItemList', 'accountItemList.subdetails'],
      }),
    });
  });

  it('reports form submission errors and always clears loading state', async () => {
    mocks.form.submit = vi.fn().mockRejectedValue(new Error('form validation failed'));

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.notification.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '提交失败',
      }),
    );
    expect(mocks.field.data.loading).toBe(false);
  });

  it('submits when the approval context has no workflow object', async () => {
    mocks.flowContext = {};

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('leaves API errors to the global error handler without showing a duplicate notification', async () => {
    mocks.create.mockRejectedValueOnce({ response: { status: 500 } });

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.notification.error).not.toHaveBeenCalled();
    expect(mocks.field.data.loading).toBe(false);
  });
});
