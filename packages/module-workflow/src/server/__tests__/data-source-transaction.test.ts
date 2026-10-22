import { createMockServer, type MockServer } from '@tachybase/test';
import { mockDatabase, Transaction } from '@tego/server';

import type { Options as SequelizeOptions } from 'sequelize';

import { withWorkflowDataSourceTransaction } from '../helpers/tenant-context';
import type PluginWorkflow from '../Plugin';

describe('workflow data source write transactions', () => {
  let app: MockServer;
  let plugin: PluginWorkflow;
  let collection;
  let statements: string[];
  let settings: SequelizeOptions;

  beforeAll(async () => {
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['error-handler', 'collection', 'user', 'workflow'],
    });
    plugin = app.pm.get('workflow') as PluginWorkflow;
    settings = (app.db.sequelize as typeof app.db.sequelize & { options: SequelizeOptions }).options;
    collection = app.db.collection({ name: 'transactionDocuments', fields: [{ name: 'title', type: 'string' }] });
    await collection.model.sync();
  });

  beforeEach(async () => {
    statements = [];
    settings.logging = (sql) => statements.push(sql);
    await collection.model.destroy({ where: {} });
    await collection.model.create({ id: 1, title: 'original' });
  });

  afterAll(async () => {
    await app?.destroy();
  });

  it('creates an immediate transaction when server code explicitly requests it', async () => {
    const transaction = await plugin.useDataSourceTransaction('main', undefined, true, {
      type: Transaction.TYPES.IMMEDIATE,
    });
    try {
      expect(statements.some((sql) => sql.includes('BEGIN IMMEDIATE TRANSACTION'))).toBe(true);
      await collection.model.destroy({ where: { id: 1 }, transaction });
    } finally {
      await transaction.rollback();
    }
    expect(await collection.model.count()).toBe(1);
  });

  it('applies explicit options before the owned transaction begins and commits the callback result', async () => {
    const result = await withWorkflowDataSourceTransaction(
      plugin,
      'main',
      undefined,
      async (transaction) => {
        expect(statements.some((sql) => sql.includes('BEGIN IMMEDIATE TRANSACTION'))).toBe(true);
        expect(transaction.options.isolationLevel).toBe(Transaction.ISOLATION_LEVELS.SERIALIZABLE);
        return collection.model.destroy({ where: { id: 1 }, transaction });
      },
      { type: Transaction.TYPES.IMMEDIATE, isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
    );
    expect(result).toBe(1);
    expect(await collection.model.count()).toBe(0);
  });

  it('rolls back an explicitly configured owned transaction when a post-write check fails', async () => {
    const error = new Error('post-write check failed');
    await expect(
      withWorkflowDataSourceTransaction(
        plugin,
        'main',
        undefined,
        async (transaction) => {
          expect(transaction.options.type).toBe(Transaction.TYPES.IMMEDIATE);
          await collection.model.destroy({ where: { id: 1 }, transaction });
          throw error;
        },
        { type: Transaction.TYPES.IMMEDIATE },
      ),
    ).rejects.toBe(error);
    expect(await collection.model.count()).toBe(1);
  });

  it('preserves a notification error after the owned transaction has already committed', async () => {
    const original = new Error('notification failed after commit');
    await expect(
      withWorkflowDataSourceTransaction(plugin, 'main', undefined, async (transaction) => {
        transaction.afterCommit(() => {
          throw original;
        });
        await collection.model.update({ title: 'committed' }, { where: { id: 1 }, transaction });
      }),
    ).rejects.toBe(original);
    expect((await collection.model.findByPk(1)).getDataValue('title')).toBe('committed');
  });

  it('preserves the callback error when its transaction has already rolled back', async () => {
    const original = new Error('callback stopped after rollback');
    await expect(
      withWorkflowDataSourceTransaction(plugin, 'main', undefined, async (transaction) => {
        await collection.model.update({ title: 'must roll back' }, { where: { id: 1 }, transaction });
        await transaction.rollback();
        throw original;
      }),
    ).rejects.toBe(original);
    expect((await collection.model.findByPk(1)).getDataValue('title')).toBe('original');
  });

  it('retains default transaction behavior when no server options are supplied', async () => {
    await withWorkflowDataSourceTransaction(plugin, 'main', undefined, async (transaction) => {
      expect(statements.some((sql) => sql.includes('BEGIN DEFERRED TRANSACTION'))).toBe(true);
      return collection.model.destroy({ where: { id: 1 }, transaction });
    });
    expect(await collection.model.count()).toBe(0);
  });

  it('preserves the database transaction type when only isolation is requested', async () => {
    const original = settings.transactionType;
    settings.transactionType = Transaction.TYPES.EXCLUSIVE;
    try {
      await withWorkflowDataSourceTransaction(
        plugin,
        'main',
        undefined,
        async (transaction) => {
          expect(statements.some((sql) => sql.includes('BEGIN EXCLUSIVE TRANSACTION'))).toBe(true);
          expect(transaction.options.isolationLevel).toBe(Transaction.ISOLATION_LEVELS.SERIALIZABLE);
          await collection.model.destroy({ where: { id: 1 }, transaction });
        },
        { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
      );
    } finally {
      settings.transactionType = original;
    }
    expect(await collection.model.count()).toBe(0);
  });

  it('preserves the database isolation default when only transaction type is requested', async () => {
    const original = settings.isolationLevel;
    settings.isolationLevel = Transaction.ISOLATION_LEVELS.SERIALIZABLE;
    try {
      await withWorkflowDataSourceTransaction(
        plugin,
        'main',
        undefined,
        async (transaction) => {
          expect(transaction.options.isolationLevel).toBe(Transaction.ISOLATION_LEVELS.SERIALIZABLE);
          await collection.model.destroy({ where: { id: 1 }, transaction });
        },
        { type: Transaction.TYPES.IMMEDIATE },
      );
    } finally {
      settings.isolationLevel = original;
    }
    expect(await collection.model.count()).toBe(0);
  });

  it('does not replace or upgrade an inherited transaction even when stronger options are requested', async () => {
    const transaction = await app.db.sequelize.transaction({ type: Transaction.TYPES.DEFERRED });
    try {
      const result = await withWorkflowDataSourceTransaction(
        plugin,
        'main',
        transaction,
        async (inherited) => {
          expect(inherited).toBe(transaction);
          expect(inherited.options.type).toBe(Transaction.TYPES.DEFERRED);
          return collection.model.destroy({ where: { id: 1 }, transaction: inherited });
        },
        { type: Transaction.TYPES.IMMEDIATE },
      );
      expect(result).toBe(1);
      expect(await collection.model.count({ transaction })).toBe(0);
    } finally {
      await transaction.rollback();
    }
    expect(await collection.model.count()).toBe(1);
    expect(statements.some((sql) => sql.includes('BEGIN IMMEDIATE TRANSACTION'))).toBe(false);
  });

  it('leaves an inherited transaction active after callback failure for its owner to roll back', async () => {
    const transaction = await app.db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE });
    const error = new Error('permission changed');
    try {
      await expect(
        withWorkflowDataSourceTransaction(
          plugin,
          'main',
          transaction,
          async (inherited) => {
            await collection.model.destroy({ where: { id: 1 }, transaction: inherited });
            throw error;
          },
          { type: Transaction.TYPES.EXCLUSIVE },
        ),
      ).rejects.toBe(error);
      expect(await collection.model.count({ transaction })).toBe(0);
    } finally {
      await transaction.rollback();
    }
    expect(await collection.model.count()).toBe(1);
  });

  it('creates the configured transaction on the external database while leaving the main transaction untouched', async () => {
    const external = mockDatabase({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const target = external.collection({ name: 'transactionDocuments', fields: [{ name: 'title', type: 'string' }] });
    await external.sync();
    await target.model.create({ id: 1, title: 'external' });
    app.dataSourceManager.dataSources.set('transactionExternal', { collectionManager: { db: external } } as any);
    const mainTransaction = await app.db.sequelize.transaction();
    try {
      const result = await withWorkflowDataSourceTransaction(
        plugin,
        'transactionExternal',
        mainTransaction,
        async (transaction) => {
          expect(transaction).not.toBe(mainTransaction);
          expect(transaction.options.type).toBe(Transaction.TYPES.IMMEDIATE);
          return target.model.destroy({ where: { id: 1 }, transaction });
        },
        { type: Transaction.TYPES.IMMEDIATE },
      );
      expect(result).toBe(1);
      expect(await target.model.count()).toBe(0);
      expect(await collection.model.count({ transaction: mainTransaction })).toBe(1);
    } finally {
      await mainTransaction.rollback();
      app.dataSourceManager.dataSources.delete('transactionExternal');
      await external.close();
    }
  });

  it('does not create a transaction when creation was not requested', async () => {
    expect(
      plugin.useDataSourceTransaction('main', undefined, false, { type: Transaction.TYPES.IMMEDIATE }),
    ).toBeUndefined();
    expect(statements.some((sql) => sql.includes('BEGIN'))).toBe(false);
  });
});
