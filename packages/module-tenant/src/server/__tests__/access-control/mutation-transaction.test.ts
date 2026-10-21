import { ACL, Transaction, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessMutationService } from '../../access-control/mutation';
import { AccessQueryService } from '../../access-control/query';
import { seedAclScopes } from './acl-database';
import { configStore, mainIdentity, seedConfigStore } from './config-database';
import { seedDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

describe('existing mutations in a caller-owned transaction', () => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let service: AccessMutationService;
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
    service = new AccessMutationService(
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
  const exists = async (id = 3) => !!(await docs.model.findByPk(id));
  const remove = (
    transaction: Transaction,
    keys = [3],
    writer = async (plan) => {
      for (const record of plan.records)
        await docs.repository.destroy({ filterByTk: record.get('id'), transaction: plan.transaction });
    },
    assertCurrent?: () => void,
  ) =>
    service.withExistingRecordsInTransaction(
      ctx,
      mainIdentity,
      { tenantId: 'B' },
      { operation: 'destroy', keys },
      transaction,
      writer,
      assertCurrent,
    );

  // Opening or committing a second transaction would lose the caller's atomic boundary.
  it('keeps a successful deletion pending until the caller rolls it back', async () => {
    const transaction = await begin();
    try {
      expect(await remove(transaction)).toEqual({ keys: [3], affected: 1 });
      expect(await docs.model.findByPk(3, { transaction })).toBeNull();
      expect(await docs.repository.count({ transaction })).toBe(5);
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(true);
  });

  it('persists a deletion only when the caller commits', async () => {
    const transaction = await begin();
    await remove(transaction);
    await transaction.commit();
    expect(await exists()).toBe(false);
  });

  it('uses the same verification and transaction ownership for scalar updates', async () => {
    const transaction = await begin();
    try {
      await service.withExistingRecordsInTransaction(
        ctx,
        mainIdentity,
        { tenantId: 'B' },
        { operation: 'update', keys: [3], values: { name: 'edited' } },
        transaction,
        async (plan) => {
          await docs.repository.update({
            filterByTk: 3,
            values: plan.valuesFor(plan.records[0]),
            transaction: plan.transaction,
          });
        },
      );
      expect((await docs.model.findByPk(3, { transaction })).get('name')).toBe('edited');
    } finally {
      await transaction.rollback();
    }
    expect((await docs.model.findByPk(3)).get('name')).toBe('D3');
  });

  it('leaves failed writer changes for the caller to roll back', async () => {
    const transaction = await begin();
    const error = new Error('write failed');
    try {
      await expect(
        remove(transaction, [3], async (plan) => {
          await docs.repository.destroy({ filterByTk: 3, transaction: plan.transaction });
          throw error;
        }),
      ).rejects.toBe(error);
      expect(await docs.repository.count({ transaction })).toBe(5);
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(true);
  });

  it('rejects a writer that leaves an authorized target undeleted', async () => {
    const transaction = await begin();
    try {
      await expect(remove(transaction, [3], async () => {})).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await docs.repository.count({ transaction })).toBe(6);
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(true);
  });

  it('rechecks the prepared phase after a successful repository deletion', async () => {
    const transaction = await begin();
    try {
      await expect(
        remove(transaction, [3], async (plan) => {
          await docs.repository.destroy({ filterByTk: 3, transaction: plan.transaction });
          adapter.release(ctx);
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
      expect(await docs.repository.count({ transaction })).toBe(5);
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(true);
  });

  it('runs the entry assertion again before returning control to the caller', async () => {
    const transaction = await begin();
    const error = new Error('entry authorization changed');
    let written = false;
    try {
      await expect(
        remove(
          transaction,
          [3],
          async (plan) => {
            await docs.repository.destroy({ filterByTk: 3, transaction: plan.transaction });
            written = true;
          },
          () => {
            if (written) throw error;
          },
        ),
      ).rejects.toBe(error);
      expect(await docs.repository.count({ transaction })).toBe(5);
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(true);
  });

  it.each([[1], [3, 4]])(
    'does not authorize visibility alone or partially delete a mixed selection: %j',
    async (...keys) => {
      const transaction = await begin();
      try {
        await expect(remove(transaction, keys)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
        expect(await docs.repository.count({ transaction })).toBe(6);
      } finally {
        await transaction.rollback();
      }
      expect(await exists()).toBe(true);
    },
  );

  it('keeps unassigned legacy data undeletable', async () => {
    const transaction = await begin();
    try {
      await expect(remove(transaction, [5])).rejects.toMatchObject({ code: 'LEGACY_DATA_READ_ONLY' });
      expect(await docs.repository.count({ transaction })).toBe(6);
    } finally {
      await transaction.rollback();
    }
    expect(await exists(5)).toBe(true);
  });

  it('rejects a transaction from another database without changing either transaction', async () => {
    const other = sqliteDatabase();
    const transaction = await other.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
    try {
      await expect(remove(transaction)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      await other.sequelize.query('SELECT 1', { transaction });
    } finally {
      await transaction.rollback();
      await other.close();
    }
    expect(await exists()).toBe(true);
  });

  it('rejects ended transactions and never opens a replacement transaction', async () => {
    const transaction = await begin();
    await transaction.commit();
    await expect(remove(transaction)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await exists()).toBe(true);
  });

  it('does not silently start its own transaction when the caller supplies none', async () => {
    await expect(remove(undefined as never)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    expect(await exists()).toBe(true);
  });

  it('rejects insufficient SQLite locking without upgrading or replacing the caller transaction', async () => {
    const transaction = await db.sequelize.transaction({ type: Transaction.TYPES.DEFERRED });
    try {
      await expect(remove(transaction)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await docs.repository.count({ transaction })).toBe(6);
    } finally {
      await transaction.rollback();
    }
    expect(await exists()).toBe(true);
  });
});
