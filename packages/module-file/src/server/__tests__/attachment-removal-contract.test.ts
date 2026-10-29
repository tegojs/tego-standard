import type { Collection, Database } from '@tego/server';

import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

/** Dependency characterization, not a deletion adapter or a production capture trigger. */
describe.skipIf(!postgresUrl)('actual repository attachment deletion evidence', () => {
  let db: Database;
  let documents: Collection;

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl!);
    documents = db.collection({
      name: 'removal_contract_files',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'path', type: 'string' },
        { name: 'filename', type: 'string' },
      ],
    });
    db.collection({
      name: 'removal_contract_receipts',
      timestamps: false,
      fields: [{ name: 'payload', type: 'jsonb' }],
    });
    await db.sync();
    await documents.repository.create({ values: { id: 1, path: 'old/H', filename: 'original.txt' } });
    // Test-only native OLD evidence lets us compare hook memory to the actual deleted SQL tuple.
    await db.sequelize.query(`
      CREATE FUNCTION capture_removal_contract() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO removal_contract_receipts(payload) VALUES (to_jsonb(OLD)); RETURN OLD; END $$;
      CREATE TRIGGER capture_actual_old AFTER DELETE ON removal_contract_files
        FOR EACH ROW EXECUTE FUNCTION capture_removal_contract();
    `);
  });

  afterEach(async () => {
    try {
      await db.sequelize.query('DROP FUNCTION IF EXISTS capture_removal_contract() CASCADE');
      await db.sequelize.query('DROP FUNCTION IF EXISTS cancel_removal_contract() CASCADE');
      await db.sequelize.drop({ cascade: true });
    } finally {
      await db?.close();
    }
  });

  async function actualRemoved() {
    const rows = await db.getCollection('removal_contract_receipts').model.findAll();
    return rows.map((row) => row.getDataValue('payload'));
  }

  it('does not mistake an afterDestroy instance mutation for the actual removed location', async () => {
    let hookFilename: string;
    documents.model.addHook('beforeDestroy', (row) => {
      row.setDataValue('filename', 'memory-only.txt');
    });
    documents.model.addHook('afterDestroy', (row) => {
      hookFilename = row.getDataValue('filename');
    });
    const result = await db.sequelize.transaction((transaction) =>
      documents.repository.destroy({ filterByTk: 1, transaction }),
    );
    expect(result).toBe(1);
    expect(hookFilename).toBe('memory-only.txt');
    expect(await actualRemoved()).toEqual([{ id: 1, path: 'old/H', filename: 'original.txt' }]);
    expect(await documents.model.findByPk(1)).toBeNull();
  });

  it('exposes only a count even when a hook changes the persisted location before DELETE', async () => {
    let hookFilename: string;
    documents.model.addHook('beforeDestroy', async (_row, { transaction }) => {
      await documents.model.update(
        { filename: 'changed-in-database.txt' },
        { where: { id: 1 }, transaction, hooks: false },
      );
    });
    documents.model.addHook('afterDestroy', (row) => {
      hookFilename = row.getDataValue('filename');
    });
    const result = await db.sequelize.transaction((transaction) =>
      documents.repository.destroy({ filterByTk: 1, transaction }),
    );
    expect(result).toBe(1);
    expect(hookFilename).toBe('original.txt');
    expect(await actualRemoved()).toEqual([{ id: 1, path: 'old/H', filename: 'changed-in-database.txt' }]);
    expect(await documents.model.findByPk(1)).toBeNull();
  });

  it('still runs afterDestroy when a SQL trigger cancels deletion of the row', async () => {
    let afterDestroy = false;
    documents.model.addHook('afterDestroy', () => {
      afterDestroy = true;
    });
    await db.sequelize.query(`
      CREATE FUNCTION cancel_removal_contract() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$;
      CREATE TRIGGER cancel_actual_delete BEFORE DELETE ON removal_contract_files
        FOR EACH ROW EXECUTE FUNCTION cancel_removal_contract();
    `);
    const result = await db.sequelize.transaction((transaction) =>
      documents.repository.destroy({ filterByTk: 1, transaction }),
    );
    expect(result).toBe(0);
    expect(afterDestroy).toBe(true);
    expect(await actualRemoved()).toEqual([]);
    expect((await documents.model.findByPk(1)).getDataValue('filename')).toBe('original.txt');
  });

  it('rolls back actual SQL deletion and native evidence despite an earlier afterDestroy callback', async () => {
    let afterDestroy = false;
    documents.model.addHook('afterDestroy', () => {
      afterDestroy = true;
    });
    documents.model.addHook('afterBulkDestroy', () => {
      throw new Error('later hook refused');
    });
    await expect(
      db.sequelize.transaction((transaction) => documents.repository.destroy({ filterByTk: 1, transaction })),
    ).rejects.toThrow('later hook refused');
    expect(afterDestroy).toBe(true);
    expect(await actualRemoved()).toEqual([]);
    expect((await documents.model.findByPk(1)).getDataValue('filename')).toBe('original.txt');
  });
});
