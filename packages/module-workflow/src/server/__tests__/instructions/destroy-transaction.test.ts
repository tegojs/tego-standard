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

  describe('asynchronous target-only planning', () => {
    const planned = (select, planner, params = { filterByTk: 1 }) =>
      new DestroyInstruction(workflow, select, undefined, planner).run(
        { id: 9, config: { collection: 'documents', params } } as any,
        null,
        processor,
      );

    it.each([
      { id: { $in: Array.from({ length: 101 }, (_, index) => index + 1) } },
      { createdAt: { $lt: new Date('2099-01-01') } },
    ])('preserves original selection when both planner and resolver decline', async (filter) => {
      const job = await planned(
        () => undefined,
        async () => undefined,
        { filterByTk: 1, filter } as any,
      );
      expect(job.result).toBe(1);
      expect(await ids()).toEqual([2]);
    });

    it('awaits planning before creating a transaction and exposes only the registered target', async () => {
      const calls: string[] = [];
      const job = await planned(
        (request) => {
          calls.push('execute');
          expect(request.transaction.options.type).toBe(Transaction.TYPES.IMMEDIATE);
          return async () => collection.repository.destroy({ filterByTk: 1, transaction: request.transaction });
        },
        async (request) => {
          calls.push('plan');
          expect(Object.keys(request).sort()).toEqual(['collection', 'collectionName', 'dataSourceName']);
          expect(Object.isFrozen(request)).toBe(true);
          expect(request.collection).toBe(collection);
          await Promise.resolve();
          expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
          return { type: Transaction.TYPES.IMMEDIATE };
        },
      );
      expect(calls).toEqual(['plan', 'execute']);
      expect(job.result).toBe(1);
      expect(await ids()).toEqual([2]);
    });

    it('preserves explicit database defaults when async planning returns undefined', async () => {
      const job = await planned(
        (request) => {
          expect(request.transaction.options.type).toBe(Transaction.TYPES.DEFERRED);
          return async () => 0;
        },
        async () => undefined,
      );
      expect(job.result).toBe(0);
      expect(await ids()).toEqual([1, 2]);
    });

    it('passes an isolated frozen selection to planning before opening the delete transaction', async () => {
      const filter = { $and: [{ 'parent.name': { $eq: 'Owned' } }] };
      const job = await planned(
        (request) => {
          expect(request.transaction.options.type).toBe(Transaction.TYPES.IMMEDIATE);
          expect(request.params.filter).toBe(filter);
          return async () => collection.repository.destroy({ filterByTk: 1, transaction: request.transaction });
        },
        async (target) => {
          const snapshot = target.captureFilter();
          expect(snapshot).toEqual(filter);
          expect(snapshot).not.toBe(filter);
          expect(Object.isFrozen(snapshot.$and)).toBe(true);
          expect(Object.isFrozen(snapshot.$and[0]['parent.name'])).toBe(true);
          expect(() => {
            snapshot.$and[0]['parent.name'].$eq = 'Injected';
          }).toThrow();
          expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
          return { type: Transaction.TYPES.IMMEDIATE };
        },
        { filterByTk: 1, filter } as any,
      );
      expect(job.result).toBe(1);
      expect(filter.$and[0]['parent.name'].$eq).toBe('Owned');
      expect(await ids()).toEqual([2]);
    });

    it.each(['filter', 'key', 'tenant'] as const)('rejects %s drift while delete planning suspends', async (part) => {
      const params = { filterByTk: 1, filter: { name: { $eq: 'first' } } };
      await expect(
        planned(
          (request) => async () =>
            collection.repository.destroy({ filterByTk: request.params.filterByTk, transaction: request.transaction }),
          async () => {
            if (part === 'filter') params.filter.name.$eq = 'second';
            else if (part === 'key') params.filterByTk = 2;
            else context.state.currentTenantId = 'C';
            return {};
          },
          params,
        ),
      ).rejects.toThrow(/inputs changed/i);
      expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
      expect(await ids()).toEqual([1, 2]);
    });

    it('rejects selection getters without evaluating them or opening a delete transaction', async () => {
      let accessed = false;
      const filter = Object.defineProperty({}, 'name', {
        enumerable: true,
        get() {
          accessed = true;
          return 'first';
        },
      });
      await expect(
        planned(
          () => async () => 0,
          async (target) => {
            target.captureFilter();
            return {};
          },
          { filterByTk: 1, filter } as any,
        ),
      ).rejects.toThrow(/filter|selection|accessor/i);
      expect(accessed).toBe(false);
      expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
      expect(await ids()).toEqual([1, 2]);
    });

    it('propagates asynchronous planning failures without opening a transaction or selecting an executor', async () => {
      const error = new Error('current policy unavailable');
      const select = vi.fn(() => undefined);
      await expect(
        planned(select, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(select).not.toHaveBeenCalled();
      expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
      expect(await ids()).toEqual([1, 2]);
    });

    it('rolls back execution failures after asynchronously selecting transaction settings', async () => {
      const error = new Error('delete verification failed');
      await expect(
        planned(
          () => async (request) => {
            await collection.repository.destroy({ filterByTk: 1, transaction: request.transaction });
            throw error;
          },
          async () => ({ type: Transaction.TYPES.IMMEDIATE }),
        ),
      ).rejects.toBe(error);
      expect(await ids()).toEqual([1, 2]);
    });

    it('never invokes async planning or replaces an inherited same-database transaction', async () => {
      const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.DEFERRED });
      processor.transaction = transaction;
      try {
        const job = await planned(
          (request) => {
            expect(request.transaction).toBe(transaction);
            return async () => collection.repository.destroy({ filterByTk: 1, transaction });
          },
          async () => {
            throw new Error('must not plan inherited transactions');
          },
        );
        expect(job.result).toBe(1);
        expect(await collection.model.count({ transaction })).toBe(1);
      } finally {
        await transaction.rollback();
      }
      expect(await ids()).toEqual([1, 2]);
    });

    it('plans an external transaction while preserving the inherited primary transaction', async () => {
      const external = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
      const target = external.collection({ name: 'documents', fields: [{ name: 'name', type: 'string' }] });
      await external.sync();
      await target.model.create({ id: 1, name: 'external' });
      workflow.app.dataSourceManager.dataSources.set('external', {
        collectionManager: { db: external, getCollection: (name) => external.getCollection(name) },
      });
      const transaction = await db.sequelize.transaction();
      processor.transaction = transaction;
      try {
        const job = await new DestroyInstruction(
          workflow,
          (request) => {
            expect(request.transaction).not.toBe(transaction);
            expect((request.transaction as Transaction & { options: { type: string } }).options.type).toBe(
              Transaction.TYPES.IMMEDIATE,
            );
            return async () => target.repository.destroy({ filterByTk: 1, transaction: request.transaction });
          },
          undefined,
          async (request) => {
            expect(request.dataSourceName).toBe('external');
            expect(request.collection).toBe(target);
            await Promise.resolve();
            return { type: Transaction.TYPES.IMMEDIATE };
          },
        ).run({ id: 9, config: { collection: 'external:documents', params: {} } } as any, null, processor);
        expect(job.result).toBe(1);
        expect(await target.model.count()).toBe(0);
        expect(await collection.model.count({ transaction })).toBe(2);
      } finally {
        await transaction.rollback();
        await external.close();
      }
      expect(await ids()).toEqual([1, 2]);
    });

    it('rejects simultaneous sync and async planning configuration', () => {
      expect(
        () =>
          new DestroyInstruction(
            workflow,
            undefined,
            () => undefined,
            async () => undefined,
          ),
      ).toThrow(/planner|planning|transaction/i);
    });

    it.each([null, false, {}])('rejects invalid async startup configuration %j', (planner) => {
      expect(() => new DestroyInstruction(workflow, undefined, undefined, planner as any)).toThrow(
        /planner must be a function/i,
      );
    });

    it('rejects async option accessors without evaluating them', async () => {
      const getter = vi.fn(() => Transaction.TYPES.IMMEDIATE);
      const result = Object.defineProperty({}, 'type', { get: getter });
      await expect(
        planned(
          () => undefined,
          async () => result,
        ),
      ).rejects.toThrow(/transaction options/i);
      expect(getter).not.toHaveBeenCalled();
      expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
    });

    it.each([null, true, 'IMMEDIATE', [], { type: 'INVALID' }, { extra: true }])(
      'rejects invalid async settings %j before executing',
      async (value) => {
        const select = vi.fn(() => undefined);
        await expect(planned(select, async () => value)).rejects.toThrow(/transaction options/i);
        expect(select).not.toHaveBeenCalled();
        expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
        expect(await ids()).toEqual([1, 2]);
      },
    );

    it('rejects target registry replacement during asynchronous planning', async () => {
      const source = workflow.app.dataSourceManager.dataSources.get('main');
      const select = vi.fn(() => undefined);
      await expect(
        planned(select, async () => {
          source.collectionManager.getCollection = () => undefined;
          return { type: Transaction.TYPES.IMMEDIATE };
        }),
      ).rejects.toThrow(/target|collection/i);
      expect(select).not.toHaveBeenCalled();
      expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
      expect(await ids()).toEqual([1, 2]);
    });

    it('rejects transaction database replacement during asynchronous planning', async () => {
      const source = workflow.app.dataSourceManager.dataSources.get('main');
      const select = vi.fn(() => async () => 0);
      await expect(
        planned(select, async () => {
          source.collectionManager.db = undefined;
          return { type: Transaction.TYPES.IMMEDIATE };
        }),
      ).rejects.toThrow(/target|database/i);
      expect(select).not.toHaveBeenCalled();
      expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
      expect(await ids()).toEqual([1, 2]);
    });

    it('rejects transaction connection replacement during asynchronous planning', async () => {
      const sequelize = db.sequelize;
      const select = vi.fn(() => async () => 0);
      try {
        await expect(
          planned(select, async () => {
            db.sequelize = undefined;
            return { type: Transaction.TYPES.IMMEDIATE };
          }),
        ).rejects.toThrow(/target|database/i);
        expect(select).not.toHaveBeenCalled();
        expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
      } finally {
        db.sequelize = sequelize;
      }
      expect(await ids()).toEqual([1, 2]);
    });
  });

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
