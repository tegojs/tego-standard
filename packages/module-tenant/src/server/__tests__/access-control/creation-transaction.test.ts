import { ACL, Transaction, type Collection, type Database } from '@tego/server';

import { withWorkflowDataSourceTransaction } from '../../../../../module-workflow/src/server/helpers/tenant-context';
import PluginWorkflow from '../../../../../module-workflow/src/server/Plugin';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessCreationService, type AccessCreationPlan } from '../../access-control/creation';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { configStore, mainIdentity, seedConfigStore } from './config-database';
import { seedDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

describe('creation in a caller-owned transaction', () => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let service: AccessCreationService;
  let ctx: object;
  let store: ReturnType<typeof configStore>;

  beforeEach(async () => {
    db = sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    await seedDatabase(db);
    docs = db.collection({
      name: 'documents',
      tableName: 'access_documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer' },
      ],
    });
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.bulkCreate(['B', 'C', 'H'].map((id) => ({ id, enabled: true })));
    store = configStore(db);
    const config = configFor(ownerCondition);
    config.rules.push({ ...configFor({ type: 'constant', value: true }, 'visibility').rules[0], id: 'visible' });
    await store.save(mainIdentity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    service = new AccessCreationService(
      db,
      adapter,
      new AccessQueryService(db, adapter, () => accessCollectionKey(mainIdentity)),
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity]);
  });
  afterEach(async () => {
    await db.close();
  });

  const begin = () => db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
  const exists = async () => !!(await docs.model.findByPk(100));
  const write = async (plan: AccessCreationPlan) => {
    const records = [];
    for (const values of plan.values)
      records.push(await docs.repository.create({ values, transaction: plan.transaction }));
    return records;
  };
  const create = (transaction: Transaction, writer = write, assertCurrent?: () => void) =>
    service.withCreatedRecordsInTransaction(
      ctx,
      mainIdentity,
      { tenantId: 'B' },
      {
        values: [{ id: 100, name: 'created', amount: 10 }],
      },
      transaction,
      writer,
      assertCurrent,
    );
  const finished = (transaction: Transaction) => (transaction as Transaction & { finished?: string }).finished;

  it('keeps a valid insert pending until the caller rolls it back', async () => {
    const transaction = await begin();
    try {
      expect(await create(transaction)).toEqual({ keys: [100], affected: 1 });
      expect((await docs.model.findByPk(100, { transaction })).getDataValue('tenantId')).toBe('B');
      expect(finished(transaction)).toBeUndefined();
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(false);
  });

  it('persists an insert only when the caller commits', async () => {
    const transaction = await begin();
    await create(transaction);
    await transaction.commit();
    expect(await exists()).toBe(true);
  });

  it.each(['commit', 'rollback'] as const)(
    'defers afterCommit notifications until the caller chooses %s',
    async (end) => {
      const transaction = await begin();
      const notified = vi.fn();
      await create(transaction, async (plan) => {
        plan.transaction.afterCommit(notified);
        return write(plan);
      });
      expect(notified).not.toHaveBeenCalled();
      await transaction[end]();
      expect(notified).toHaveBeenCalledTimes(end === 'commit' ? 1 : 0);
      expect(await exists()).toBe(end === 'commit');
    },
  );

  it('leaves all failed writer changes for the caller to roll back and preserves the original error', async () => {
    const transaction = await begin();
    const error = new Error('business creation failed');
    try {
      await docs.model.update({ name: 'earlier caller write' }, { where: { id: 3 }, transaction });
      await expect(
        create(transaction, async (plan) => {
          await write(plan);
          throw error;
        }),
      ).rejects.toBe(error);
      expect(await docs.model.findByPk(100, { transaction })).not.toBeNull();
      expect(finished(transaction)).toBeUndefined();
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(false);
    expect((await docs.model.findByPk(3)).getDataValue('name')).toBe('D3');
  });

  it('uses actual INSERT receipts instead of trusting a writer returning an old authorized row', async () => {
    const transaction = await begin();
    try {
      await expect(
        create(transaction, async (plan) => {
          await write(plan);
          return [await docs.model.findByPk(3, { transaction })];
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(finished(transaction)).toBeUndefined();
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(false);
  });

  it('rejects a persisted ownership change after writing', async () => {
    const transaction = await begin();
    try {
      await expect(
        create(transaction, async (plan) => {
          const records = await write(plan);
          await docs.model.update({ tenantId: 'C' }, { where: { id: 100 }, transaction });
          return records;
        }),
      ).rejects.toMatchObject({ code: 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN' });
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(false);
  });

  it('does not authorize a new record using visibility alone', async () => {
    const config = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      { ...config, rules: config.rules.filter((rule) => rule.category === 'visibility') },
      { userId: 28 },
    );
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity]);
    const transaction = await begin();
    try {
      await expect(create(transaction)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(false);
  });

  it('rechecks the prepared phase after the repository insert', async () => {
    const transaction = await begin();
    try {
      await expect(
        create(transaction, async (plan) => {
          const records = await write(plan);
          adapter.release(ctx);
          return records;
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(false);
  });

  it('rechecks the live entry after writing and before returning', async () => {
    const transaction = await begin();
    const error = new Error('operation proof expired');
    let written = false;
    try {
      await expect(
        create(
          transaction,
          async (plan) => {
            const records = await write(plan);
            written = true;
            return records;
          },
          () => {
            if (written) throw error;
          },
        ),
      ).rejects.toBe(error);
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(false);
  });

  it('captures caller inputs before the first asynchronous validation', async () => {
    const transaction = await begin();
    const identity = { ...mainIdentity };
    const actor = { tenantId: 'B' };
    const values = [{ id: 100, name: 'snapshot', amount: 10 }];
    try {
      const result = service.withCreatedRecordsInTransaction(ctx, identity, actor, { values }, transaction, write);
      actor.tenantId = 'C';
      identity.collectionKey = 'changed';
      values[0].amount = 999;
      expect(await result).toEqual({ keys: [100], affected: 1 });
      expect((await docs.model.findByPk(100, { transaction })).getDataValue('tenantId')).toBe('B');
      expect((await docs.model.findByPk(100, { transaction })).getDataValue('amount')).toBe(10);
    } finally {
      await transaction.rollback();
    }
  });

  it.each(['success', 'writer failure', 'verification failure'] as const)(
    'removes the temporary INSERT observer after %s while the transaction is still active',
    async (outcome) => {
      const transaction = await begin();
      const observerCount = () =>
        ((db.sequelize as unknown as { options: { hooks: { afterQuery?: unknown[] } } }).options.hooks.afterQuery ?? [])
          .length;
      const baseline = observerCount();
      const error = new Error('writer failed');
      try {
        const pending = create(transaction, async (plan) => {
          const records = await write(plan);
          if (outcome === 'writer failure') throw error;
          if (outcome === 'verification failure') return [await docs.model.findByPk(3, { transaction })];
          return records;
        });
        if (outcome === 'success') expect(await pending).toMatchObject({ affected: 1 });
        else if (outcome === 'writer failure') await expect(pending).rejects.toBe(error);
        else await expect(pending).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(observerCount()).toBe(baseline);
        expect(finished(transaction)).toBeUndefined();
      } finally {
        await transaction.rollback();
      }
    },
  );

  it('retains the concurrency conflict response without ending the caller transaction', async () => {
    const transaction = await begin();
    const error = Object.assign(new Error('serialization failure'), { original: { code: '40001' } });
    try {
      await expect(
        create(transaction, async () => {
          throw error;
        }),
      ).rejects.toMatchObject({
        code: 'ACCESS_MUTATION_CONFLICT',
        status: 409,
      });
      expect(finished(transaction)).toBeUndefined();
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(false);
  });

  it('isolates concurrent creation receipts within the same transaction and model', async () => {
    const transaction = await begin();
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const concurrentWriter = async (plan: AccessCreationPlan) => {
      if (++arrivals === 2) release();
      await ready;
      return write(plan);
    };
    try {
      const results = await Promise.allSettled(
        [100, 101].map((id) =>
          service.withCreatedRecordsInTransaction(
            ctx,
            mainIdentity,
            { tenantId: 'B' },
            {
              values: [{ id, name: 'parallel', amount: 10 }],
            },
            transaction,
            concurrentWriter,
          ),
        ),
      );
      expect(results).toEqual([100, 101].map((id) => ({ status: 'fulfilled', value: { keys: [id], affected: 1 } })));
      for (const id of [100, 101])
        expect((await docs.model.findByPk(id, { transaction })).getDataValue('tenantId')).toBe('B');
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(false);
    expect(await docs.model.findByPk(101)).toBeNull();
  });

  it('restores outer receipt tracking after an independently authorized nested creation', async () => {
    const transaction = await begin();
    try {
      expect(
        await create(transaction, async (plan) => {
          expect(
            await service.withCreatedRecordsInTransaction(
              ctx,
              mainIdentity,
              { tenantId: 'B' },
              {
                values: [{ id: 101, name: 'nested', amount: 10 }],
              },
              transaction,
              write,
            ),
          ).toEqual({ keys: [101], affected: 1 });
          return write(plan);
        }),
      ).toEqual({ keys: [100], affected: 1 });
      for (const id of [100, 101]) expect(await docs.model.findByPk(id, { transaction })).not.toBeNull();
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(false);
    expect(await docs.model.findByPk(101)).toBeNull();
  });

  it.each([undefined, null, {}])(
    'rejects an absent or non-transaction argument without running the writer: %s',
    async (input) => {
      const writer = vi.fn(write);
      await expect(create(input as Transaction, writer)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(writer).not.toHaveBeenCalled();
      expect(await exists()).toBe(false);
    },
  );

  it('rejects another database transaction without ending or replacing it', async () => {
    const other = sqliteDatabase();
    const transaction = await other.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
    try {
      const writer = vi.fn(write);
      await expect(create(transaction, writer)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(writer).not.toHaveBeenCalled();
      await other.sequelize.query('SELECT 1', { transaction });
    } finally {
      await transaction.rollback();
      await other.close();
    }
  });

  it.each(['commit', 'rollback'] as const)('rejects a transaction already ended by %s', async (end) => {
    const transaction = await begin();
    await transaction[end]();
    const writer = vi.fn(write);
    await expect(create(transaction, writer)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(writer).not.toHaveBeenCalled();
    expect(await exists()).toBe(false);
  });

  it('rejects insufficient SQLite locking without upgrading the transaction', async () => {
    const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.DEFERRED });
    try {
      const writer = vi.fn(write);
      await expect(create(transaction, writer)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(writer).not.toHaveBeenCalled();
      expect(finished(transaction)).toBeUndefined();
    } finally {
      await transaction.rollback();
    }
  });

  it('rejects a read-only transaction before invoking the writer', async () => {
    const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE, readOnly: true });
    try {
      const writer = vi.fn(write);
      await expect(create(transaction, writer)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(writer).not.toHaveBeenCalled();
    } finally {
      await transaction.rollback();
    }
  });

  it('rejects a nested savepoint without changing either caller transaction', async () => {
    const parent = await begin();
    const nested = await db.sequelize.transaction({ transaction: parent });
    try {
      const writer = vi.fn(write);
      await expect(create(nested, writer)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(writer).not.toHaveBeenCalled();
      expect(finished(parent)).toBeUndefined();
    } finally {
      await nested.rollback();
      await parent.rollback();
    }
  });

  describe('workflow-owned transaction boundary', () => {
    function execute(writer = write, assertion?: () => void, inherited?: Transaction) {
      const workflow = {
        app: { dataSourceManager: { dataSources: new Map([['main', { collectionManager: { db } }]]) } },
        useDataSourceTransaction: PluginWorkflow.prototype.useDataSourceTransaction,
      };
      return withWorkflowDataSourceTransaction(
        workflow,
        'main',
        inherited,
        (transaction) => create(transaction, writer, assertion),
        { type: Transaction.TYPES.IMMEDIATE },
      );
    }

    it('commits only after unified creation verification succeeds', async () => {
      expect(await execute()).toEqual({ keys: [100], affected: 1 });
      expect(await exists()).toBe(true);
    });

    it('rolls back earlier and current inserts when later entry verification fails', async () => {
      const error = new Error('later entry check failed');
      let written = false;
      await expect(
        execute(
          async (plan) => {
            await docs.model.update(
              { name: 'earlier workflow write' },
              { where: { id: 3 }, transaction: plan.transaction },
            );
            const records = await write(plan);
            written = true;
            return records;
          },
          () => {
            if (written) throw error;
          },
        ),
      ).rejects.toBe(error);
      expect(await exists()).toBe(false);
      expect((await docs.model.findByPk(3)).getDataValue('name')).toBe('D3');
    });

    it('leaves a valid inherited workflow transaction pending', async () => {
      const transaction = await begin();
      try {
        expect(await execute(write, undefined, transaction)).toEqual({ keys: [100], affected: 1 });
        expect(finished(transaction)).toBeUndefined();
      } finally {
        await transaction.rollback();
      }
      expect(await exists()).toBe(false);
    });
  });
});
