import { describe, expect, it, vi } from 'vitest';

import { exportXlsx } from '../actions/export-xlsx';

vi.mock('../renders', () => ({
  default: vi.fn().mockResolvedValue({ rows: [['header']], ranges: [] }),
}));

vi.mock('node-xlsx', () => ({
  default: { build: vi.fn().mockReturnValue(Buffer.from('fake-xlsx')) },
}));

function createHttpError(status: number, message: string) {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function createExportCtx(columns?: any, valuesColumns?: any) {
  const mockCollection = {
    hasField: vi.fn((name: string) => ['id', 'title'].includes(name)),
    getField: vi.fn().mockReturnValue(null),
    fields: {
      get: vi.fn((name: string) => ({
        name,
        type: name === 'id' ? 'integer' : 'string',
        options: { interface: 'input' },
      })),
    },
  };

  const mockRepository = {
    collection: mockCollection,
    count: vi.fn().mockResolvedValue(1),
    find: vi.fn().mockResolvedValue([]),
  };

  const params: any = {
    filter: {},
    title: 'Posts Export',
  };

  if (arguments.length >= 1) {
    params.columns = columns;
  }

  if (arguments.length >= 2) {
    params.values = { columns: valuesColumns };
  }

  const ctx: any = {
    action: {
      params,
      resourceName: 'e2e_tenant_posts',
      resourceOf: undefined,
    },
    state: {
      currentTenantId: 'tenant-a',
      currentTenancyMode: 'tenantScoped',
      currentUser: { id: 1 },
      actorUserId: 1,
    },
    db: {
      getRepository: vi.fn().mockReturnValue(mockRepository),
      getCollection: vi.fn().mockReturnValue(mockCollection),
    },
    app: {
      emit: vi.fn(),
    },
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    throw: vi.fn((status: number, message: string) => {
      throw createHttpError(status, message);
    }),
    tego: {},
  };

  return { ctx, mockCollection, mockRepository };
}

const next = vi.fn().mockResolvedValue(undefined);

describe('exportXlsx columns parsing', () => {
  it('should export when columns is the string array shape used by API smoke verification', async () => {
    const { ctx, mockCollection } = createExportCtx(['id', 'title']);

    await exportXlsx(ctx, next);

    expect(mockCollection.hasField).toHaveBeenCalledWith('id');
    expect(mockCollection.hasField).toHaveBeenCalledWith('title');
    expect(ctx.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Disposition': expect.stringContaining('Posts%20Export_tenant-a.xlsx'),
      }),
    );
  });

  it('should export when columns is missing', async () => {
    const { ctx, mockRepository } = createExportCtx();

    await expect(exportXlsx(ctx, next)).resolves.not.toThrow();

    expect(mockRepository.find).toHaveBeenCalled();
    expect(ctx.throw).not.toHaveBeenCalled();
  });

  it('should export when columns is an empty array', async () => {
    const { ctx, mockRepository } = createExportCtx([]);

    await expect(exportXlsx(ctx, next)).resolves.not.toThrow();

    expect(mockRepository.find).toHaveBeenCalled();
    expect(ctx.throw).not.toHaveBeenCalled();
  });

  it('should export when columns is a valid JSON string', async () => {
    const { ctx, mockCollection } = createExportCtx(JSON.stringify(['title']));

    await exportXlsx(ctx, next);

    expect(mockCollection.hasField).toHaveBeenCalledWith('title');
    expect(ctx.throw).not.toHaveBeenCalled();
  });

  it('should return 400 when columns JSON cannot be parsed', async () => {
    const { ctx } = createExportCtx('[{"dataIndex":["id"]}');

    await expect(exportXlsx(ctx, next)).rejects.toMatchObject({
      status: 400,
      message: 'Invalid export columns: columns must be valid JSON',
    });
  });

  it('should return 400 when columns has an invalid structure', async () => {
    const { ctx } = createExportCtx({ dataIndex: ['id'] });

    await expect(exportXlsx(ctx, next)).rejects.toMatchObject({
      status: 400,
      message: 'Invalid export columns: columns must be an array',
    });
  });

  it('should preserve normal column objects from values.columns', async () => {
    const paramsColumns = ['id'];
    const valuesColumns = [{ dataIndex: ['title'], title: 'Title' }];
    const { ctx, mockCollection } = createExportCtx(paramsColumns, valuesColumns);

    await exportXlsx(ctx, next);

    expect(mockCollection.hasField).toHaveBeenCalledWith('title');
    expect(mockCollection.hasField).not.toHaveBeenCalledWith('id');
  });
});
