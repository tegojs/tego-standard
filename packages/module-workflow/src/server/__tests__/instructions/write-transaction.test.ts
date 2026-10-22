import { mockDatabase, Transaction } from '@tego/server';

import { JOB_STATUS } from '../../constants';
import { CreateInstruction } from '../../instructions/CreateInstruction';
import { UpdateInstruction } from '../../instructions/UpdateInstruction';
import PluginWorkflow from '../../Plugin';

describe.each(['create', 'update'] as const)('workflow %s asynchronous transaction planning', (action) => {
  let db: ReturnType<typeof mockDatabase>;
  let collection;
  let workflow;
  let processor;
  let context;
  let parsed;
  let statements: string[];
  const Instruction = action === 'create' ? CreateInstruction : UpdateInstruction;

  beforeEach(async () => {
    statements = [];
    db = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: (sql) => statements.push(sql) });
    collection = db.collection({ name: 'documents', fields: [{ name: 'name', type: 'string' }] });
    await db.sync();
    await collection.model.create({ id: 1, name: 'Original' });
    workflow = {
      app: {
        authManager: { jwt: { sign: () => 'unused' } },
        dataSourceManager: {
          dataSources: new Map([
            ['main', { collectionManager: { db, getCollection: (name) => db.getCollection(name) } }],
          ]),
        },
      },
    };
    workflow.useDataSourceTransaction = PluginWorkflow.prototype.useDataSourceTransaction.bind(workflow);
    context = { state: { currentTenantId: 'B', currentUserId: 28, currentRole: 'worker' } };
    processor = {
      getParsedValue: (value) => {
        parsed = value;
        return value;
      },
      getRepositoryContext: () => context,
      getScope: () => ({}),
      transaction: undefined,
    };
    statements = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  const run = (resolve?, planner?, source = 'documents', values = { name: 'Changed' }) =>
    new Instruction(workflow, resolve, planner).run(
      { id: 9, config: { collection: source, params: { filterByTk: 1, values } } } as any,
      null,
      processor,
    );
  const selected = async (request) => {
    const { repository } = request.collection;
    if (action === 'create') {
      return (
        await repository.create({
          values: { id: 3, name: request.params.values.name },
          transaction: request.transaction,
        })
      ).toJSON();
    }
    const records = await repository.update({
      filter: { id: 1 },
      values: { name: request.params.values.name },
      transaction: request.transaction,
    });
    return { length: records.length, data: records.map((record) => record.toJSON()) };
  };
  const names = async () =>
    (await collection.model.findAll({ order: [['id', 'ASC']] })).map((record) => record.get('name'));

  it('awaits planning before beginning the selected write transaction', async () => {
    const calls: string[] = [];
    const job = await run(
      (request) => {
        calls.push('select');
        expect(request.transaction.options.type).toBe(Transaction.TYPES.IMMEDIATE);
        return selected;
      },
      async (target) => {
        calls.push('plan');
        expect(Object.keys(target).sort()).toEqual(['collection', 'collectionName', 'dataSourceName', 'valueFields']);
        expect(Object.isFrozen(target)).toBe(true);
        expect(target.collection).toBe(collection);
        expect(target.collectionName).toBe('documents');
        expect(target.dataSourceName).toBe('main');
        await Promise.resolve();
        expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
        return { type: Transaction.TYPES.IMMEDIATE };
      },
    );
    expect(calls).toEqual(['plan', 'select']);
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(await names()).toEqual(action === 'create' ? ['Original', 'Changed'] : ['Changed']);
  });
  it('keeps database defaults when planning explicitly returns undefined', async () => {
    const job = await run(
      (request) => {
        expect(request.transaction.options.type).toBe(Transaction.TYPES.DEFERRED);
        return selected;
      },
      async () => undefined,
    );
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
  });
  it('passes only frozen value field names to transaction planning', async () => {
    const job = await run(
      () => selected,
      async (target) => {
        expect(target.valueFields).toEqual(['name']);
        expect(Object.isFrozen(target.valueFields)).toBe(true);
        expect(target.params).toBeUndefined();
        expect(target.context).toBeUndefined();
        expect(target.valueFields).not.toContain('Changed');
        return { type: Transaction.TYPES.IMMEDIATE };
      },
    );
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(await names()).toEqual(action === 'create' ? ['Original', 'Changed'] : ['Changed']);
  });
  it('does not evaluate field value getters to describe a write', async () => {
    let accessed = false;
    const values = Object.defineProperty({}, 'name', {
      enumerable: true,
      get() {
        accessed = true;
        return 'Secret value';
      },
    });
    const job = await run(
      () => async () => (action === 'create' ? { id: 99 } : { length: 0, data: [] }),
      async (target) => {
        expect(target.valueFields).toEqual(['name']);
        return { type: Transaction.TYPES.IMMEDIATE };
      },
      'documents',
      values as { name: string },
    );
    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(accessed).toBe(false);
    expect(await names()).toEqual(['Original']);
  });
  it.each([false, true])(
    'uses the planned transaction for original writes (resolver installed: %s)',
    async (installed) => {
      const job = await run(installed ? () => undefined : undefined, async () => ({
        type: Transaction.TYPES.IMMEDIATE,
      }));
      expect(job.status).toBe(JOB_STATUS.RESOLVED);
      expect(statements.some((sql) => /BEGIN IMMEDIATE/.test(sql))).toBe(true);
      expect(await names()).toEqual(action === 'create' ? ['Original', 'Changed'] : ['Changed']);
    },
  );
  it('preserves planning failures before selection, attachments or transactions', async () => {
    collection.getField('name').options.interface = 'attachment';
    const error = new Error('policy unavailable');
    let selected = false;
    await expect(
      run(
        () => {
          selected = true;
        },
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(selected).toBe(false);
    expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
    expect(await names()).toEqual(['Original']);
  });
  it('rolls back a selected write when subsequent verification fails', async () => {
    const error = new Error('write verification failed');
    await expect(
      run(
        () => async (request) => {
          await selected(request);
          throw error;
        },
        async () => ({ type: Transaction.TYPES.IMMEDIATE }),
      ),
    ).rejects.toBe(error);
    expect(await names()).toEqual(['Original']);
  });
  it('never plans or ends a same-database caller transaction', async () => {
    const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.DEFERRED });
    processor.transaction = transaction;
    try {
      const job = await run(
        (request) => {
          expect(request.transaction).toBe(transaction);
          return selected;
        },
        async () => {
          throw new Error('inherited transaction must not be planned');
        },
      );
      expect(job.status).toBe(JOB_STATUS.RESOLVED);
      expect((transaction as Transaction & { finished?: string }).finished).toBeUndefined();
    } finally {
      await transaction.rollback();
    }
    expect(await names()).toEqual(['Original']);
  });
  it('plans for an external target without ending the primary caller transaction', async () => {
    const external = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const documents = external.collection({ name: 'documents', fields: [{ name: 'name', type: 'string' }] });
    await external.sync();
    await documents.model.create({ id: 1, name: 'External' });
    workflow.app.dataSourceManager.dataSources.set('external', {
      collectionManager: { db: external, getCollection: (name) => external.getCollection(name) },
    });
    const transaction = await db.sequelize.transaction();
    processor.transaction = transaction;
    try {
      const job = await run(
        (request) => {
          expect(request.transaction).not.toBe(transaction);
          expect(request.transaction.options.type).toBe(Transaction.TYPES.IMMEDIATE);
          return selected;
        },
        async (target) => {
          expect(target.dataSourceName).toBe('external');
          expect(target.collection).toBe(documents);
          return { type: Transaction.TYPES.IMMEDIATE };
        },
        'external:documents',
      );
      expect(job.status).toBe(JOB_STATUS.RESOLVED);
      expect((await documents.model.findByPk(action === 'create' ? 3 : 1)).get('name')).toBe('Changed');
      expect((transaction as Transaction & { finished?: string }).finished).toBeUndefined();
    } finally {
      await transaction.rollback();
      await external.close();
    }
    expect(await names()).toEqual(['Original']);
  });
  it.each([null, false, {}])('rejects invalid startup planner %j', (planner) => {
    expect(() => new Instruction(workflow, undefined, planner as any)).toThrow(/planner must be a function/i);
  });
  it.each([null, true, 'IMMEDIATE', [], { type: 'INVALID' }, { extra: true }, { isolationLevel: 'INVALID' }])(
    'rejects invalid planned settings %j before selecting a writer',
    async (settings) => {
      let selected = false;
      await expect(
        run(
          () => {
            selected = true;
          },
          async () => settings,
        ),
      ).rejects.toThrow(/transaction options/i);
      expect(selected).toBe(false);
      expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
      expect(await names()).toEqual(['Original']);
    },
  );
  it('does not evaluate option accessors', async () => {
    let accessed = false;
    const settings = Object.defineProperty({}, 'type', {
      get() {
        accessed = true;
        return Transaction.TYPES.IMMEDIATE;
      },
    });
    await expect(
      run(
        () => selected,
        async () => settings,
      ),
    ).rejects.toThrow(/transaction options/i);
    expect(accessed).toBe(false);
    expect(await names()).toEqual(['Original']);
  });
  it.each(['values', 'tenant', 'user', 'role'] as const)(
    'rejects %s drift during planning before writing',
    async (part) => {
      await expect(
        run(
          () => selected,
          async () => {
            if (part === 'values') parsed.values.name = 'Injected';
            else if (part === 'tenant') context.state.currentTenantId = 'C';
            else if (part === 'user') context.state.currentUserId = 99;
            else context.state.currentRole = 'root';
            return { type: Transaction.TYPES.IMMEDIATE };
          },
        ),
      ).rejects.toThrow(/inputs changed during planning/i);
      expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
      expect(await names()).toEqual(['Original']);
    },
  );
  it('rechecks planning inputs after opening the transaction and rolls it back on drift', async () => {
    const begin = db.sequelize.transaction.bind(db.sequelize);
    vi.spyOn(db.sequelize, 'transaction').mockImplementation(async (...args) => {
      const transaction = await begin(...args);
      parsed.values.name = 'Injected';
      return transaction;
    });
    await expect(
      run(
        () => selected,
        async () => ({ type: Transaction.TYPES.IMMEDIATE }),
      ),
    ).rejects.toThrow(/inputs changed during planning/i);
    expect(statements.some((sql) => /ROLLBACK/.test(sql))).toBe(true);
    expect(await names()).toEqual(['Original']);
  });
  it.each(['source', 'manager', 'collection', 'database', 'connection'] as const)(
    'rejects %s replacement across planning',
    async (part) => {
      const sources = workflow.app.dataSourceManager.dataSources;
      const source = sources.get('main');
      const manager = source.collectionManager;
      const connection = db.sequelize;
      let selected = false;
      try {
        await expect(
          run(
            () => {
              selected = true;
            },
            async () => {
              if (part === 'source') sources.set('main', {});
              else if (part === 'manager') source.collectionManager = {};
              else if (part === 'collection') manager.getCollection = () => undefined;
              else if (part === 'database') manager.db = undefined;
              else db.sequelize = undefined;
              return { type: Transaction.TYPES.IMMEDIATE };
            },
          ),
        ).rejects.toThrow(/target changed/i);
      } finally {
        db.sequelize = connection;
      }
      expect(selected).toBe(false);
      expect(statements.some((sql) => /BEGIN /.test(sql))).toBe(false);
      expect(await names()).toEqual(['Original']);
    },
  );
});
