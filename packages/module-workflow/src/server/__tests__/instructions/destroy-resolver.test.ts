import { mockDatabase } from '@tego/server';

import { JOB_STATUS } from '../../constants';
import { DestroyInstruction } from '../../instructions/DestroyInstruction';

describe('workflow destroy executor selection', () => {
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
    await collection.repository.create({ values: { id: 1, title: 'owned', tenantId: 'branch' } });
    await collection.repository.create({ values: { id: 2, title: 'other', tenantId: 'other' } });
    workflow = {
      app: { dataSourceManager: { dataSources: new Map([['main', { collectionManager: db }]]) } },
      useDataSourceTransaction: (_name, transaction, create) =>
        transaction ?? (create ? db.sequelize.transaction() : undefined),
    };
    context = { state: { currentTenantId: 'branch', currentRole: 'worker', currentUser: { id: 7 } } };
    processor = {
      getParsedValue: (value) => value,
      getRepositoryContext: () => context,
      transaction: undefined,
    };
  });

  afterEach(async () => {
    await db.close();
  });

  function run(resolve, params: Record<string, unknown> = { filter: {} }) {
    return new DestroyInstruction(workflow, resolve).run(
      { id: 9, config: { collection: 'documents', params } } as any,
      null,
      processor,
    );
  }
  async function ids() {
    return (await collection.repository.find({ sort: ['id'] })).map((record) => record.get('id'));
  }

  // Ignoring the selected executor would delete both records through the legacy path.
  it('uses the selected deletion and count without also running the default repository deletion', async () => {
    const job = await run(() => async (request) => {
      expect(request.dataSourceName).toBe('main');
      expect(request.collectionName).toBe('documents');
      expect(request.collection).toBe(collection);
      expect(request.context).toBe(context);
      expect(request.params).toEqual({ filter: {} });
      return request.collection.repository.destroy({
        filter: { tenantId: request.context.state.currentTenantId },
        context: request.context,
        transaction: request.transaction,
      });
    });
    expect(job).toEqual({ status: JOB_STATUS.RESOLVED, result: 1 });
    expect(await ids()).toEqual([2]);
  });

  it('preserves the legacy tenant restriction when selection is explicitly absent', async () => {
    collection.options.tenancy = 'tenantScoped';
    const job = await run(() => undefined);
    expect(job.result).toBe(1);
    expect(await ids()).toEqual([2]);
  });

  it('keeps unconfigured instructions on the legacy deletion path', async () => {
    collection.options.tenancy = 'tenantScoped';
    const job = await run(undefined);
    expect(job.result).toBe(1);
    expect(await ids()).toEqual([2]);
  });

  it('does not apply the legacy same-tenant filter to a selected executor', async () => {
    collection.options.tenancy = 'tenantScoped';
    const job = await run(
      () => (request) => request.collection.repository.destroy({ filter: { id: 2 }, transaction: request.transaction }),
    );
    expect(job.result).toBe(1);
    expect(await ids()).toEqual([1]);
  });

  it('does not merge node-supplied context into the trusted selected execution identity', async () => {
    const job = await run(
      () => async (request) => {
        expect(request.context).toBe(context);
        expect(request.context.state).not.toHaveProperty('injected');
        return 0;
      },
      { filter: {}, context: { state: { currentTenantId: 'other', injected: true } } },
    );
    expect(job.result).toBe(0);
    expect(await ids()).toEqual([1, 2]);
  });

  it.each(['selection', 'execution'])(
    'propagates %s errors without deleting through the legacy path',
    async (stage) => {
      const error = new Error('operation denied');
      const reject = () => {
        throw error;
      };
      await expect(run(stage === 'selection' ? reject : () => reject)).rejects.toBe(error);
      expect(await ids()).toEqual([1, 2]);
    },
  );

  it.each([null, false, {}, Promise.resolve(undefined)])(
    'rejects invalid selections without deleting: %s',
    async (selection) => {
      await expect(run(() => selection)).rejects.toThrow('Destroy resolver must select an executor or undefined');
      expect(await ids()).toEqual([1, 2]);
    },
  );

  it('consumes rejected asynchronous selection without falling back', async () => {
    const error = new Error('invalid asynchronous selection');
    await expect(run(() => Promise.reject(error))).rejects.toBe(error);
    expect(await ids()).toEqual([1, 2]);
  });

  it.each([null, false, {}])('rejects invalid resolver configuration: %s', (resolve) => {
    expect(() => new DestroyInstruction(workflow, resolve as any)).toThrow('Destroy resolver must be a function');
  });

  it('rolls back owned transaction writes when the selected executor fails', async () => {
    const error = new Error('post-write verification failed');
    await expect(
      run(() => async (request) => {
        await collection.repository.destroy({ filter: { id: 1 }, transaction: request.transaction });
        throw error;
      }),
    ).rejects.toBe(error);
    expect(await ids()).toEqual([1, 2]);
  });

  it.each([undefined, null, false, {}, [], -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rolls back writes if the selected executor returns an invalid count: %s',
    async (result) => {
      await expect(
        run(() => async (request) => {
          await collection.repository.destroy({ filter: { id: 1 }, transaction: request.transaction });
          return result;
        }),
      ).rejects.toThrow('Invalid destroy executor result');
      expect(await ids()).toEqual([1, 2]);
    },
  );

  it('retains an inherited transaction without committing it inside the instruction', async () => {
    const transaction = await db.sequelize.transaction();
    processor.transaction = transaction;
    try {
      const job = await run(() => async (request) => {
        expect(request.transaction).toBe(transaction);
        return collection.repository.destroy({ filter: { id: 1 }, transaction: request.transaction });
      });
      expect(job.result).toBe(1);
      expect(await collection.repository.count({ transaction })).toBe(1);
    } finally {
      await transaction.rollback();
    }
    expect(await ids()).toEqual([1, 2]);
  });

  it('leaves an inherited transaction for the caller to roll back after an executor error', async () => {
    const transaction = await db.sequelize.transaction();
    processor.transaction = transaction;
    const error = new Error('post-write check failed');
    try {
      await expect(
        run(() => async (request) => {
          await collection.repository.destroy({ filter: { id: 1 }, transaction: request.transaction });
          throw error;
        }),
      ).rejects.toBe(error);
      expect(await collection.repository.count({ transaction })).toBe(1);
    } finally {
      await transaction.rollback();
    }
    expect(await ids()).toEqual([1, 2]);
  });

  it('targets the requested external data source and uses its own transaction instead of the main one', async () => {
    const external = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const target = external.collection({ name: 'documents', fields: [{ name: 'title', type: 'string' }] });
    await external.sync();
    await target.repository.create({ values: { id: 1, title: 'external' } });
    const mainTransaction = await db.sequelize.transaction();
    processor.transaction = mainTransaction;
    workflow.app.dataSourceManager.dataSources.set('external', { collectionManager: external });
    workflow.useDataSourceTransaction = (name, transaction, create) => {
      const database = name === 'external' ? external : db;
      return database.sequelize === transaction?.sequelize
        ? transaction
        : create
          ? database.sequelize.transaction()
          : undefined;
    };
    try {
      const job = await new DestroyInstruction(workflow, () => async (request) => {
        expect(request.dataSourceName).toBe('external');
        expect(request.collectionName).toBe('documents');
        expect(request.collection).toBe(target);
        expect(request.transaction).not.toBe(mainTransaction);
        return target.repository.destroy({ filter: { id: 1 }, transaction: request.transaction });
      }).run(
        { id: 9, config: { collection: 'external:documents', params: { filter: { id: 1 } } } } as any,
        null,
        processor,
      );
      expect(job.result).toBe(1);
      expect(await target.repository.count()).toBe(0);
      expect(await collection.repository.count({ transaction: mainTransaction })).toBe(2);
    } finally {
      await mainTransaction.rollback();
      await external.close();
    }
    expect(await ids()).toEqual([1, 2]);
  });
});
