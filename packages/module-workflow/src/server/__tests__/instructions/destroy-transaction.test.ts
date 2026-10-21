import { mockDatabase, Transaction } from '@tego/server';

import { DestroyInstruction } from '../../instructions/DestroyInstruction';
import PluginWorkflow from '../../Plugin';

describe('server-selected workflow destroy transaction options', () => {
  let db: ReturnType<typeof mockDatabase>;
  let collection;
  let workflow;
  let context;
  let processor;
  let statements: string[];

  beforeEach(async () => {
    statements = [];
    db = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: (sql) => statements.push(sql) });
    collection = db.collection({
      name: 'documents',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    await db.sync();
    await collection.model.bulkCreate([
      { id: 1, name: 'first', tenantId: 'B' },
      { id: 2, name: 'second', tenantId: 'C' },
    ]);
    workflow = {
      app: {
        dataSourceManager: {
          dataSources: new Map([
            ['main', { collectionManager: { db, getCollection: (name) => db.getCollection(name) } }],
          ]),
        },
      },
    };
    workflow.useDataSourceTransaction = PluginWorkflow.prototype.useDataSourceTransaction.bind(workflow);
    context = { state: { currentTenantId: 'B' } };
    processor = { getParsedValue: (value) => value, getRepositoryContext: () => context, transaction: undefined };
    statements = [];
  });
  afterEach(async () => {
    await db.close();
  });

  const run = (select, plan?, params = {}) =>
    new DestroyInstruction(workflow, select, plan).run(
      { id: 9, config: { collection: 'documents', params } } as any,
      null,
      processor,
    );
  const ids = async () => (await collection.model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get('id'));

  it('retains default transaction behavior without a server planner', async () => {
    await run(() => async (request) => {
      expect(request.transaction.options.type).toBe(Transaction.TYPES.DEFERRED);
      return 0;
    });
    expect(statements.some((sql) => sql.includes('BEGIN DEFERRED TRANSACTION'))).toBe(true);
    expect(await ids()).toEqual([1, 2]);
  });

  it('plans before opening the new transaction and still selects the executor inside it', async () => {
    const calls: string[] = [];
    const job = await run(
      (request) => {
        calls.push('select');
        expect(request.transaction.options.type).toBe(Transaction.TYPES.IMMEDIATE);
        expect(request.transaction.options.isolationLevel).toBe(Transaction.ISOLATION_LEVELS.SERIALIZABLE);
        expect(statements.some((sql) => sql.includes('BEGIN IMMEDIATE TRANSACTION'))).toBe(true);
        return async () => collection.repository.destroy({ filterByTk: 1, transaction: request.transaction });
      },
      (request) => {
        calls.push('plan');
        expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
        expect(request).toMatchObject({
          dataSourceName: 'main',
          collectionName: 'documents',
          params: { filterByTk: 1 },
        });
        expect(request.collection).toBe(collection);
        expect(request.context).toBe(context);
        expect(request).not.toHaveProperty('transaction');
        return { type: Transaction.TYPES.IMMEDIATE, isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE };
      },
      { filterByTk: 1 },
    );
    expect(calls).toEqual(['plan', 'select']);
    expect(job.result).toBe(1);
    expect(await ids()).toEqual([2]);
  });

  it('uses trusted execution context rather than the node-supplied context during planning', async () => {
    const plan = vi.fn((request) => {
      expect(request.context.state).toEqual({ currentTenantId: 'B' });
      return { type: Transaction.TYPES.IMMEDIATE };
    });
    await run(() => async () => 0, plan, { context: { state: { currentTenantId: 'C', injected: true } } });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('retains database defaults when the planner returns undefined', async () => {
    const job = await run(
      (request) => {
        expect(request.transaction.options.type).toBe(Transaction.TYPES.DEFERRED);
        return async () => 0;
      },
      () => undefined,
    );
    expect(job.result).toBe(0);
    expect(await ids()).toEqual([1, 2]);
  });

  it('rolls back planned transaction writes after an executor failure', async () => {
    const error = new Error('post-write verification failed');
    await expect(
      run(
        () => async (request) => {
          await collection.repository.destroy({ filterByTk: 1, transaction: request.transaction });
          throw error;
        },
        () => ({ type: Transaction.TYPES.IMMEDIATE }),
      ),
    ).rejects.toBe(error);
    expect(await ids()).toEqual([1, 2]);
  });

  it('keeps the legacy tenant restriction when the executor is absent and a transaction is planned', async () => {
    collection.options.tenancy = 'tenantScoped';
    const job = await run(
      () => undefined,
      () => ({ type: Transaction.TYPES.IMMEDIATE }),
      { filter: {} },
    );
    expect(job.result).toBe(1);
    expect(await ids()).toEqual([2]);
  });

  it('does not let node parameters choose transaction options', async () => {
    await run(
      (request) => {
        expect(request.transaction.options.type).toBe(Transaction.TYPES.DEFERRED);
        return async () => 0;
      },
      undefined,
      { transactionOptions: { type: Transaction.TYPES.IMMEDIATE } },
    );
    expect(statements.some((sql) => sql.includes('BEGIN DEFERRED TRANSACTION'))).toBe(true);
    expect(await ids()).toEqual([1, 2]);
  });

  it('plans and commits an external target transaction without modifying the inherited main transaction', async () => {
    const external = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const target = external.collection({ name: 'documents', fields: [{ name: 'name', type: 'string' }] });
    await external.sync();
    await target.model.create({ id: 1, name: 'external' });
    workflow.app.dataSourceManager.dataSources.set('external', {
      collectionManager: { db: external, getCollection: (name) => external.getCollection(name) },
    });
    const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.DEFERRED });
    processor.transaction = transaction;
    try {
      const plan = vi.fn((request) => {
        expect(request.dataSourceName).toBe('external');
        expect(request.collection).toBe(target);
        return { type: Transaction.TYPES.IMMEDIATE };
      });
      const job = await new DestroyInstruction(
        workflow,
        (request) => {
          expect(request.transaction).not.toBe(transaction);
          const actual = request.transaction as Transaction & { options: { type: string } };
          expect(actual.options.type).toBe(Transaction.TYPES.IMMEDIATE);
          return async () => target.repository.destroy({ filterByTk: 1, transaction: request.transaction });
        },
        plan,
      ).run({ id: 9, config: { collection: 'external:documents', params: {} } } as any, null, processor);
      expect(plan).toHaveBeenCalledTimes(1);
      expect(job.result).toBe(1);
      expect(await target.model.count()).toBe(0);
      expect(await collection.model.count({ transaction })).toBe(2);
    } finally {
      await transaction.rollback();
      await external.close();
    }
    expect(await ids()).toEqual([1, 2]);
  });

  it('never plans, replaces or ends a same-database inherited transaction', async () => {
    const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.DEFERRED });
    const plan = vi.fn(() => {
      throw new Error('must not run');
    });
    processor.transaction = transaction;
    try {
      expect(
        (
          await run((request) => {
            expect(request.transaction).toBe(transaction);
            return async () => collection.repository.destroy({ filterByTk: 1, transaction });
          }, plan)
        ).result,
      ).toBe(1);
      expect(plan).not.toHaveBeenCalled();
      expect(await collection.model.count({ transaction })).toBe(1);
    } finally {
      await transaction.rollback();
    }
    expect(await ids()).toEqual([1, 2]);
  });

  it('propagates planning errors before opening any transaction or executing the fallback', async () => {
    const error = new Error('transaction policy unavailable');
    const select = vi.fn(() => undefined);
    await expect(
      run(select, () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(select).not.toHaveBeenCalled();
    expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
    expect(await ids()).toEqual([1, 2]);
  });

  it.each([
    { selected: null },
    { selected: false },
    { selected: [] },
    { selected: { readOnly: true } },
    { selected: { type: 'invalid' } },
    { selected: { isolationLevel: 'invalid' } },
    { selected: Promise.resolve(undefined) },
  ])('rejects invalid planner output before any transaction starts: %j', async ({ selected }) => {
    const select = vi.fn(() => undefined);
    await expect(run(select, () => selected)).rejects.toThrow('Invalid destroy transaction options');
    expect(select).not.toHaveBeenCalled();
    expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
    expect(await ids()).toEqual([1, 2]);
  });

  it('rejects planner option accessors without evaluating them', async () => {
    let evaluated = false;
    const selected = Object.defineProperty({}, 'type', {
      get() {
        evaluated = true;
        return Transaction.TYPES.IMMEDIATE;
      },
    });
    await expect(
      run(
        () => undefined,
        () => selected,
      ),
    ).rejects.toThrow('Invalid destroy transaction options');
    expect(evaluated).toBe(false);
    expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
    expect(await ids()).toEqual([1, 2]);
  });

  it('consumes a rejected asynchronous planner without falling back', async () => {
    const error = new Error('invalid async transaction planner');
    await expect(
      run(
        () => undefined,
        () => Promise.reject(error),
      ),
    ).rejects.toBe(error);
    expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
    expect(await ids()).toEqual([1, 2]);
  });

  it.each([null, false, {}])('rejects invalid planner startup configuration: %j', (plan) => {
    expect(() => new DestroyInstruction(workflow, undefined, plan as any)).toThrow(
      'Destroy transaction options must be a function',
    );
  });
});
