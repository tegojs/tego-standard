import { mockDatabase, Transaction } from '@tego/server';

import { JOB_STATUS } from '../../constants';
import { CreateInstruction } from '../../instructions/CreateInstruction';
import { UpdateInstruction } from '../../instructions/UpdateInstruction';
import PluginWorkflow from '../../Plugin';

describe.each(['create', 'update'] as const)('workflow %s executor selection', (action) => {
  let db: ReturnType<typeof mockDatabase>;
  let collection;
  let workflow;
  let processor;
  let context;
  const Instruction = action === 'create' ? CreateInstruction : UpdateInstruction;

  beforeEach(async () => {
    db = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
    collection = db.collection({
      name: 'writeDocuments',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    await db.sync();
    await collection.model.bulkCreate([
      { id: 1, title: 'owned', tenantId: 'branch' },
      { id: 2, title: 'other', tenantId: 'other' },
    ]);
    workflow = {
      app: {
        authManager: { jwt: { sign: vi.fn(() => 'unused') } },
        dataSourceManager: {
          dataSources: new Map([
            ['main', { collectionManager: { db, getCollection: (name) => db.getCollection(name) } }],
          ]),
        },
      },
    };
    workflow.useDataSourceTransaction = PluginWorkflow.prototype.useDataSourceTransaction.bind(workflow);
    context = { state: { currentTenantId: 'branch', currentRole: 'worker' } };
    processor = {
      getParsedValue: (value) => value,
      getRepositoryContext: () => context,
      getScope: () => ({}),
      transaction: undefined,
    };
  });
  afterEach(async () => {
    await db.close();
  });

  const run = (resolve?, extra = {}, source = 'writeDocuments') =>
    new Instruction(workflow, resolve).run(
      {
        id: 9,
        config: {
          collection: source,
          params: { filterByTk: 1, values: { title: 'configured' }, ...extra },
        },
      } as any,
      null,
      processor,
    );
  const rows = async () =>
    (await collection.model.findAll({ order: [['id', 'ASC']] })).map((row) => ({
      id: row.get('id'),
      title: row.get('title'),
    }));
  const result =
    action === 'create' ? { id: 99, title: 'selected' } : { length: 1, data: [{ id: 99, title: 'selected' }] };

  it('uses only the selected executor and returns its established job shape', async () => {
    const selected = vi.fn(async (request) => {
      expect(Object.isFrozen(request)).toBe(true);
      expect(request.collection).toBe(collection);
      expect(request.dataSourceName).toBe('main');
      expect(request.collectionName).toBe(collection.name);
      expect(request.context).toBe(context);
      expect(request.transaction.sequelize).toBe(db.sequelize);
      expect(request.params.values).toEqual({ title: 'configured' });
      return result;
    });
    expect(await run(() => selected)).toEqual({ status: JOB_STATUS.RESOLVED, result });
    expect(selected).toHaveBeenCalledTimes(1);
    expect(workflow.app.authManager.jwt.sign).not.toHaveBeenCalled();
    expect(await rows()).toEqual([
      { id: 1, title: 'owned' },
      { id: 2, title: 'other' },
    ]);
  });

  it.each([false, true])(
    'retains the original write when selection is absent (resolver installed: %s)',
    async (installed) => {
      collection.options.tenancy = 'tenantScoped';
      const job = await run(installed ? () => undefined : undefined);
      expect(job.status).toBe(JOB_STATUS.RESOLVED);
      if (action === 'create') {
        expect(job.result).toMatchObject({ title: 'configured', tenantId: 'branch' });
        expect(await collection.model.count()).toBe(3);
      } else {
        expect(job.result).toMatchObject({ length: 1, data: [{ id: 1, title: 'configured' }] });
        expect(await collection.model.count()).toBe(2);
      }
      expect((await rows())[1]).toEqual({ id: 2, title: 'other' });
    },
  );

  it('uses trusted repository identity rather than node-supplied context', async () => {
    await run(
      () => async (request) => {
        expect(request.context).toBe(context);
        expect(request.context.state).not.toHaveProperty('injected');
        return result;
      },
      { context: { state: { currentTenantId: 'other', injected: true } } },
    );
  });

  it('does not add the old tenant filter to a selected execution', async () => {
    collection.options.tenancy = 'tenantScoped';
    await run(() => async (request) => {
      await collection.repository.update({
        filterByTk: 2,
        values: { title: 'selected' },
        transaction: request.transaction,
      });
      return result;
    });
    expect((await rows())[1].title).toBe('selected');
  });

  it('rejects before attempting default attachment preparation', async () => {
    const field = collection.getField('title');
    field.options.interface = 'attachment';
    const error = new Error('attachment write denied');
    await expect(
      run(
        () => {
          throw error;
        },
        { values: { title: 'not-a-resource-url' } },
      ),
    ).rejects.toBe(error);
    expect(workflow.app.authManager.jwt.sign).not.toHaveBeenCalled();
    expect(await collection.model.count()).toBe(2);
  });

  if (action === 'update') {
    it('keeps a selected zero-update result valid', async () => {
      expect((await run(() => async () => ({ length: 0, data: [] }))).result).toEqual({ length: 0, data: [] });
      expect((await rows())[0].title).toBe('owned');
    });
  }

  it('exposes the complete configured projection without doing a second default read', async () => {
    const find = vi.spyOn(collection.repository, 'findOne');
    await run(
      () => async (request) => {
        expect(request.params.appends).toEqual(['someRelation.name']);
        return result;
      },
      { appends: ['someRelation.name'] },
    );
    expect(find).not.toHaveBeenCalled();
  });

  it.each(['selection', 'execution'])('does not fall back after %s failure', async (stage) => {
    const error = new Error('write access denied');
    const fail = () => {
      throw error;
    };
    await expect(run(stage === 'selection' ? fail : () => fail)).rejects.toBe(error);
    expect(workflow.app.authManager.jwt.sign).not.toHaveBeenCalled();
    expect(await rows()).toEqual([
      { id: 1, title: 'owned' },
      { id: 2, title: 'other' },
    ]);
  });

  it('rolls back a node-owned transaction after an executor writes then fails', async () => {
    const error = new Error('write verification failed');
    await expect(
      run(() => async (request) => {
        await collection.repository.update({
          filterByTk: 1,
          values: { title: 'invalid' },
          transaction: request.transaction,
        });
        throw error;
      }),
    ).rejects.toBe(error);
    expect((await rows())[0].title).toBe('owned');
  });

  it.each([null, false, {}, Promise.resolve(undefined)])(
    'rejects invalid synchronous selection %s',
    async (selection) => {
      await expect(run(() => selection)).rejects.toThrow(/resolver must select/i);
      expect(workflow.app.authManager.jwt.sign).not.toHaveBeenCalled();
      expect(await collection.model.count()).toBe(2);
    },
  );

  it('consumes rejected asynchronous selection without falling back', async () => {
    const error = new Error('unsupported async selection');
    await expect(run(() => Promise.reject(error))).rejects.toBe(error);
    expect(workflow.app.authManager.jwt.sign).not.toHaveBeenCalled();
  });

  it.each(
    action === 'create'
      ? [null, undefined, [], false]
      : [
          null,
          undefined,
          [],
          { length: -1, data: [] },
          { length: 1.5, data: [] },
          { length: 0, data: [{}] },
          { length: 1, data: null },
        ],
  )('rolls back writes on invalid selected result %j', async (value) => {
    await expect(
      run(() => async (request) => {
        await collection.repository.update({
          filterByTk: 1,
          values: { title: 'invalid' },
          transaction: request.transaction,
        });
        return value;
      }),
    ).rejects.toThrow(/executor result/i);
    expect((await rows())[0].title).toBe('owned');
  });

  it('preserves caller ownership of an inherited same-database transaction', async () => {
    const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
    processor.transaction = transaction;
    try {
      await run(() => async (request) => {
        expect(request.transaction).toBe(transaction);
        await collection.repository.update({ filterByTk: 1, values: { title: 'in transaction' }, transaction });
        return result;
      });
      expect((await collection.model.findByPk(1, { transaction })).get('title')).toBe('in transaction');
      expect((transaction as Transaction & { finished?: string }).finished).toBeUndefined();
    } finally {
      await transaction.rollback();
    }
    expect((await rows())[0].title).toBe('owned');
  });

  it('also reuses the inherited transaction for explicit default fallback', async () => {
    const transaction = await db.sequelize.transaction();
    processor.transaction = transaction;
    try {
      await run(() => undefined);
      expect((transaction as Transaction & { finished?: string }).finished).toBeUndefined();
      if (action === 'create') expect(await collection.model.count({ transaction })).toBe(3);
      else expect((await collection.model.findByPk(1, { transaction })).get('title')).toBe('configured');
    } finally {
      await transaction.rollback();
    }
    expect(await collection.model.count()).toBe(2);
    expect((await rows())[0].title).toBe('owned');
  });

  it('creates an external transaction without replacing the inherited primary transaction', async () => {
    const external = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const target = external.collection({ name: collection.name, fields: [{ name: 'title', type: 'string' }] });
    await external.sync();
    await target.model.create({ id: 1, title: 'external' });
    workflow.app.dataSourceManager.dataSources.set('external', {
      collectionManager: { db: external, getCollection: (name) => external.getCollection(name) },
    });
    const transaction = await db.sequelize.transaction();
    processor.transaction = transaction;
    try {
      await run(
        () => async (request) => {
          expect(request.collection).toBe(target);
          expect(request.dataSourceName).toBe('external');
          expect(request.transaction).not.toBe(transaction);
          expect(request.transaction.sequelize).toBe(external.sequelize);
          await target.repository.update({
            filterByTk: 1,
            values: { title: 'external committed' },
            transaction: request.transaction,
          });
          return result;
        },
        {},
        `external:${collection.name}`,
      );
      expect((await target.model.findByPk(1)).get('title')).toBe('external committed');
      expect((transaction as Transaction & { finished?: string }).finished).toBeUndefined();
    } finally {
      await transaction.rollback();
      await external.close();
    }
    expect((await rows())[0].title).toBe('owned');
  });

  it.each([null, false, {}])('rejects invalid startup resolver %j', (resolve) => {
    expect(() => new Instruction(workflow, resolve as any)).toThrow(/resolver must be a function/i);
  });
});
