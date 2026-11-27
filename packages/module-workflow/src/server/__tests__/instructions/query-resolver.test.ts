import { mockDatabase } from '@tego/server';

import { JOB_STATUS } from '../../constants';
import { QueryInstruction } from '../../instructions/QueryInstruction';

describe('workflow query executor selection', () => {
  let db: ReturnType<typeof mockDatabase>;
  let collection;
  let workflow;
  let context;
  let processor;

  beforeEach(async () => {
    db = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
    collection = db.collection({
      name: 'documents',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    await db.sync();
    await collection.repository.create({ values: { id: 1, title: 'visible', tenantId: 'branch' } });
    await collection.repository.create({ values: { id: 2, title: 'hidden', tenantId: 'other' } });
    workflow = {
      app: {
        dataSourceManager: {
          dataSources: new Map([['main', { collectionManager: db }]]),
        },
      },
      useDataSourceTransaction: (_name, transaction) => transaction,
    };
    context = { state: { currentTenantId: 'branch', currentRole: 'reader', currentUser: { id: 7 } } };
    processor = {
      getParsedValue: (value) => value,
      getRepositoryContext: () => context,
      transaction: undefined,
    };
  });

  afterEach(async () => {
    await db.close();
  });

  function run(resolve, config = {}) {
    return new QueryInstruction(workflow, resolve).run(
      { id: 9, config: { collection: 'documents', multiple: true, ...config } } as any,
      null,
      processor,
    );
  }

  // Ignoring the selected executor would leak the second record from the default query.
  it('uses selected results instead of running the default repository query', async () => {
    const job = await run(() => async (request) => {
      expect(request.collection).toBe(collection);
      expect(request.dataSourceName).toBe('main');
      expect(request.collectionName).toBe('documents');
      expect(request.context).toBe(context);
      expect(request.multiple).toBe(true);
      return collection.repository.find({ filter: { tenantId: request.context.state.currentTenantId } });
    });
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result).toMatchObject([{ id: 1, title: 'visible' }]);
    expect(job.result).toHaveLength(1);
  });

  it('preserves the legacy tenant filter only when no executor is selected', async () => {
    collection.options.tenancy = 'tenantScoped';
    for (const resolve of [undefined, () => undefined]) {
      const job = await run(resolve);
      expect(job.result).toMatchObject([{ id: 1 }]);
      expect(job.result).toHaveLength(1);
    }
  });

  it('does not intersect a selected query with the legacy same-tenant filter', async () => {
    collection.options.tenancy = 'tenantScoped';
    const job = await run(() => (request) => collection.repository.find(request.query));
    expect(job.result).toMatchObject([{ id: 1 }, { id: 2 }]);
    expect(job.result).toHaveLength(2);
  });

  it('propagates selected authorization failures without falling back', async () => {
    const error = new Error('scope denied');
    await expect(
      run(() => async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it('propagates selection errors without falling back', async () => {
    const error = new Error('configuration unavailable');
    await expect(
      run(() => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it.each([null, false, {}, Promise.resolve(undefined)])('rejects invalid selection %s', async (selection) => {
    await expect(run(() => selection)).rejects.toThrow('Query resolver must select an executor or undefined');
  });

  it('consumes and propagates rejected asynchronous selection', async () => {
    const error = new Error('asynchronous selection rejected');
    await expect(run(() => Promise.reject(error))).rejects.toBe(error);
  });

  it.each([null, false, {}])('rejects invalid resolver configuration %s', (resolve) => {
    expect(() => new QueryInstruction(workflow, resolve as any)).toThrow('Query resolver must be a function');
  });

  it('normalizes dates, sorting, paging and appends before handing off the query', async () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    const params = {
      filter: { createdAt: { $gt: date } },
      sort: [{ field: 'id', direction: 'desc' }, { direction: 'asc' }],
      appends: ['parent.name'],
      page: 2,
      pageSize: 3,
    };
    const job = await run(
      () => async (request) => {
        expect(request.query).toEqual({
          filter: { createdAt: { $gt: '2026-01-02T03:04:05.000Z' } },
          sort: ['-id'],
          appends: ['parent', 'parent.name'],
          limit: 3,
          offset: 3,
          tree: true,
        });
        request.query.filter.createdAt.$gt = 'changed';
        return [];
      },
      { params, isTree: true },
    );
    expect(job.result).toEqual([]);
    expect(params.filter.createdAt.$gt).toBe(date);
    expect(params.appends).toEqual(['parent.name']);
  });

  it('hands off the existing data source transaction and context', async () => {
    const transaction = await db.sequelize.transaction();
    processor.transaction = transaction;
    try {
      const job = await run(() => async (request) => {
        expect(request.transaction).toBe(transaction);
        return request.collection.repository.find({
          ...request.query,
          filter: { id: 1 },
          transaction: request.transaction,
          context: request.context,
        });
      });
      expect(job.result).toMatchObject([{ id: 1 }]);
      expect(job.result).toHaveLength(1);
    } finally {
      await transaction.rollback();
    }
  });

  it.each([
    { multiple: true, result: [], status: JOB_STATUS.FAILED },
    { multiple: false, result: null, status: JOB_STATUS.FAILED },
    { multiple: false, result: { id: 1 }, status: JOB_STATUS.RESOLVED },
  ])('retains failOnEmpty for selected results: %s', async ({ multiple, result, status }) => {
    const job = await run(() => async () => result, { multiple, failOnEmpty: true });
    expect(job).toEqual({ result, status });
  });

  it.each([
    { multiple: true, result: null },
    { multiple: true, result: {} },
    { multiple: false, result: [] },
    { multiple: false, result: undefined },
  ])('rejects malformed selected results: %s', async ({ multiple, result }) => {
    await expect(run(() => async () => result, { multiple })).rejects.toThrow('Invalid query executor result');
  });
});
