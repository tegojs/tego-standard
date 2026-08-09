import { createForm } from '@tachybase/schema';
import { renderHook } from '@tachybase/test/client';

import { Toast } from 'antd-mobile';
import { beforeEach, vi } from 'vitest';

import { useSubmitCreate } from '../useSubmitCreate';

const mocks = vi.hoisted(() => ({
  configuredPaths: [] as string[],
  create: vi.fn(),
  collection: { getField: vi.fn() },
  field: { data: {} },
  flowContext: { workflow: { id: 1304, key: 'approval-copy' } },
  form: null as ReturnType<typeof createForm> | null,
  isMobile: false,
  blockContext: { __parent: undefined as { service?: { refresh: () => unknown } } | undefined },
  notification: { error: vi.fn() },
}));

vi.mock('@tachybase/client', () => ({
  joinCollectionName: (dataSource: string, collection: string) => `${dataSource}:${collection}`,
  useActionContext: () => ({}),
  useAPIClient: () => ({
    notification: mocks.notification,
    resource: () => ({ create: mocks.create }),
  }),
  useBlockRequestContext: () => mocks.blockContext,
  useCollection_deprecated: () => ({
    dataSource: 'main',
    name: 'receipt',
    getField: mocks.collection.getField,
  }),
  useFormBlockContext: () => ({ updateAssociationValues: mocks.configuredPaths }),
  useIsMobile: () => mocks.isMobile,
}));

vi.mock('@tachybase/module-workflow/client', () => ({
  useFlowContext: () => mocks.flowContext,
}));

vi.mock('../../../locale', () => ({
  useTranslation: () => ({ t: (key: string) => `translated:${key}` }),
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
    mocks.isMobile = false;
    mocks.create.mockReset().mockResolvedValue({ status: 200 });
    mocks.collection.getField.mockReset().mockImplementation((name: string) => {
      const fields = {
        accountItemList: { type: 'hasMany', target: 'account_items' },
        configuredDetails: { type: 'belongsToMany', target: 'details' },
        'accountItemList.subdetails': { type: 'hasMany', target: 'subdetails' },
        plainNester: { type: 'string' },
      };
      return fields[name];
    });
    mocks.notification.error.mockReset();
    vi.mocked(Toast.show).mockClear();
    mocks.blockContext = { __parent: undefined };
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

    const copyPaths = ['configuredDetails', 'accountItemList', 'accountItemList.subdetails'];
    expect(mocks.create).toHaveBeenCalledWith({
      values: expect.objectContaining({
        copyAssociationValues: copyPaths,
      }),
    });
  });

  it('ignores copy controls that do not map to association fields', async () => {
    mocks.form.createField({
      name: 'plainNester',
      component: ['CollectionField', { mode: 'Nester' }],
    });

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.create).toHaveBeenCalledWith({
      values: expect.objectContaining({
        copyAssociationValues: [],
      }),
    });
  });

  it('reports form submission errors and always clears loading state', async () => {
    mocks.form.submit = vi.fn().mockRejectedValue(new Error('form validation failed'));

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.notification.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'translated:Submit failed',
      }),
    );
    expect(mocks.field.data.loading).toBe(false);
  });

  it('does not submit when neither a workflow id nor key is available', async () => {
    mocks.flowContext = {};

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.notification.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'translated:Submit failed',
        description: 'translated:Approval workflow identifier is required',
      }),
    );
  });

  it('leaves API errors to the global error handler without showing a duplicate notification', async () => {
    mocks.create.mockRejectedValueOnce({ response: { status: 500 } });

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.notification.error).not.toHaveBeenCalled();
    expect(mocks.field.data.loading).toBe(false);
  });

  it('reports errors thrown while cleaning up after a successful request', async () => {
    mocks.form.reset = vi.fn(() => {
      throw new Error('reset failed');
    });

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.notification.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'translated:Submission succeeded, but post-processing failed',
        description: 'reset failed',
      }),
    );
    expect(mocks.field.data.loading).toBe(false);
  });

  it('reports asynchronous service refresh failures after a successful request', async () => {
    mocks.blockContext = {
      __parent: {
        service: {
          refresh: vi.fn().mockRejectedValue(new Error('refresh failed')),
        },
      },
    };

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(mocks.notification.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'translated:Submission succeeded, but post-processing failed',
        description: 'refresh failed',
      }),
    );
    expect(mocks.field.data.loading).toBe(false);
  });

  it('uses a localized success message on mobile', async () => {
    mocks.isMobile = true;

    const { result } = renderHook(() => useSubmitCreate());

    await result.current.run({});

    expect(Toast.show).toHaveBeenCalledWith({
      icon: 'success',
      content: 'translated:Submit succeeded',
    });
  });
});
