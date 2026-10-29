import { randomUUID } from 'node:crypto';
import type { Collection, Database, Transaction } from '@tego/server';

import * as files from '..';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.skipIf(!postgresUrl)('explicit PostgreSQL attachment delete capture', () => {
  let db: Database;
  let source: Collection;
  let evidence: Collection;
  let capture: InstanceType<typeof files.AttachmentRemovalNativeCapture>;

  beforeEach(async () => {
    db = isolatedPostgresDatabase(postgresUrl!);
    source = db.collection({
      name: 'native_capture_files',
      schema: 'public',
      template: 'file',
      timestamps: false,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true },
        { name: 'tenantId', type: 'string' },
        { name: 'path', type: 'string' },
        { name: 'filename', type: 'string', field: 'stored_name' },
        { name: 'storageId', type: 'integer' },
        { name: 'size', type: 'integer' },
      ],
    });
    evidence = db.collection({
      name: 'native_capture_evidence',
      schema: 'public',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'payload', type: 'jsonb' },
      ],
    });
    await db.sync();
    await source.repository.create({
      values: {
        id: '9007199254740993',
        tenantId: 'B',
        path: 'old/H',
        filename: 'original.txt',
        storageId: 18,
        size: 27,
      },
    });
  });

  afterEach(async () => {
    try {
      if (capture) await db.sequelize.query(`DROP FUNCTION IF EXISTS ${capture.functionName}() CASCADE`);
      await db.sequelize.query('DROP FUNCTION IF EXISTS cancel_native_capture() CASCADE');
      await db.sequelize.query('DROP TABLE IF EXISTS public."native_""files$body$"');
      await db.sequelize.drop({ cascade: true });
    } finally {
      await db?.close();
      capture = undefined;
    }
  });

  async function install() {
    capture = new files.AttachmentRemovalNativeCapture(source, evidence);
    await db.sequelize.transaction((transaction) => capture.install(transaction));
  }

  async function mark(transaction: Transaction, id = randomUUID()) {
    await db.sequelize.query('SELECT set_config($setting, $id, true)', {
      transaction,
      bind: { setting: capture.setting, id },
    });
    return id;
  }

  const rows = () => evidence.model.findAll();
  const remove = (transaction: Transaction) =>
    source.repository.destroy({ filterByTk: '9007199254740993', transaction });

  describe('full-row native event format', () => {
    async function installFullRow() {
      capture = new files.AttachmentRemovalNativeCapture(source, evidence, 'full-row');
      await db.sequelize.transaction((transaction) => capture.install(transaction));
    }

    it('retains complete actual business fields and exact SQL bigint values without a JavaScript round trip', async () => {
      source.setField('approved', { type: 'boolean', field: 'business_approved' });
      source.setField('details', { type: 'jsonb' });
      source.setField('amount', { type: 'bigInt' });
      await db.sequelize.query(`ALTER TABLE native_capture_files
        ADD COLUMN business_approved boolean DEFAULT TRUE,
        ADD COLUMN details jsonb DEFAULT '{"flag":true,"n":9007199254740993}',
        ADD COLUMN amount bigint DEFAULT 9007199254740993`);
      await installFullRow();
      let after = false;
      source.model.addHook('beforeDestroy', async (row, { transaction }) => {
        row.setDataValue('approved', true);
        await source.model.update({ approved: false }, { where: {}, transaction, hooks: false });
      });
      source.model.addHook('afterDestroy', () => {
        after = true;
      });
      let id: string;
      await db.sequelize.transaction(async (transaction) => {
        id = await mark(transaction);
        expect(await remove(transaction)).toBe(1);
      });
      expect(after).toBe(true);
      const [result] = await db.sequelize.query(
        `SELECT
        payload->>'schemaVersion' AS version,
        payload->'row'->>'id' AS key,
        payload->'row'->>'amount' AS amount,
        payload->'row'->'details'->>'n' AS nested,
        (SELECT r.business_approved FROM jsonb_populate_record(NULL::native_capture_files, payload->'row') r) AS approved,
        (SELECT r.amount::text FROM jsonb_populate_record(NULL::native_capture_files, payload->'row') r) AS restored
        FROM native_capture_evidence WHERE id=$id`,
        { bind: { id: id! } },
      );
      expect(result).toEqual([
        {
          version: '2',
          key: '9007199254740993',
          amount: '9007199254740993',
          nested: '9007199254740993',
          approved: false,
          restored: '9007199254740993',
        },
      ]);
      expect(await source.model.count()).toBe(0);
    });

    it('verifies full-row installation from a fresh full-row instance but rejects the old format', async () => {
      await installFullRow();
      const verifier = new files.AttachmentRemovalNativeCapture(source, evidence, 'full-row');
      await db.sequelize.transaction((transaction) => verifier.assertInstalled(transaction));
      const legacy = new files.AttachmentRemovalNativeCapture(source, evidence);
      await expect(db.sequelize.transaction((transaction) => legacy.assertInstalled(transaction))).rejects.toThrow(
        'Native removal capture installation is unavailable or changed',
      );
      expect(await source.model.count()).toBe(1);
      expect(await rows()).toEqual([]);
    });

    it('evaluates exact bigint and nested JSON inside the original transaction with a colliding root alias', async () => {
      source.setField('amount', { type: 'bigInt' });
      source.setField('details', { type: 'jsonb' });
      await db.sequelize.query(`ALTER TABLE native_capture_files
        ADD COLUMN amount bigint DEFAULT 9007199254740993,
        ADD COLUMN details jsonb DEFAULT '{"n":9007199254740993}'`);
      await installFullRow();
      let id: string;
      let header: Record<string, unknown>;
      const predicate = {
        rootAlias: 'tac_native_event',
        sql: `"tac_native_event".id=9007199254740993 AND "tac_native_event".amount=9007199254740993
          AND "tac_native_event".details->>'n'='9007199254740993'`,
      };
      await db.sequelize.transaction(async (transaction) => {
        id = await mark(transaction);
        await remove(transaction);
        const [results] = await db.sequelize.query(
          `SELECT payload-'row' AS header FROM native_capture_evidence WHERE id=$id`,
          { transaction, bind: { id } },
        );
        header = (results as { header: Record<string, unknown> }[])[0].header;
        expect(await capture.testFullRowPredicate(source, transaction, id, header, predicate)).toBe(true);
        expect(
          await capture.testFullRowPredicate(source, transaction, id, header, {
            rootAlias: 'tac_native_event',
            sql: '"tac_native_event".amount=9007199254740992',
          }),
        ).toBe(false);
      });
      await expect(
        db.sequelize.transaction((transaction) =>
          capture.testFullRowPredicate(source, transaction, id!, header!, predicate),
        ),
      ).rejects.toThrow('Native full-row event does not match its prepared intent');
    });

    it('compares the native physical column set independently of JavaScript and database Unicode sort order', async () => {
      const bmp = 'column_\uE000';
      const astral = 'column_\u{10000}';
      source.setField('bmpValue', { type: 'string', field: bmp });
      source.setField('astralValue', { type: 'string', field: astral });
      await db.sequelize.query(
        `ALTER TABLE native_capture_files ADD COLUMN "${bmp}" text, ADD COLUMN "${astral}" text`,
      );
      await installFullRow();
      await db.sequelize.transaction(async (transaction) => {
        const id = await mark(transaction);
        await remove(transaction);
        const [results] = await db.sequelize.query(
          `SELECT payload-'row' AS header FROM native_capture_evidence WHERE id=$id`,
          {
            transaction,
            bind: { id },
          },
        );
        const header = (results as { header: Record<string, unknown> }[])[0].header;
        expect(
          await capture.testFullRowPredicate(source, transaction, id, header, {
            rootAlias: 'actual_old',
            sql: '"actual_old".id=9007199254740993',
          }),
        ).toBe(true);
      });
    });

    it.each(['add', 'remove', 'rename', 'type'])(
      'rejects %s drift of ordinary business field metadata captured for the full row',
      async (change) => {
        source.setField('approved', { type: 'boolean' });
        await db.sequelize.query('ALTER TABLE native_capture_files ADD COLUMN approved boolean');
        capture = new files.AttachmentRemovalNativeCapture(source, evidence, 'full-row');
        if (change === 'add') source.setField('later', { type: 'string' });
        else if (change === 'remove') delete source.model.rawAttributes.approved;
        else if (change === 'rename') source.model.rawAttributes.approved.field = 'renamed';
        else source.model.rawAttributes.approved.type = source.model.rawAttributes.path.type;
        await expect(db.sequelize.transaction((transaction) => capture.install(transaction))).rejects.toThrow(
          'Native removal capture metadata is unavailable or changed',
        );
        expect(await source.model.count()).toBe(1);
        expect(await rows()).toEqual([]);
      },
    );

    it('rejects unmodeled physical columns instead of silently treating a partial definition as the full row', async () => {
      capture = new files.AttachmentRemovalNativeCapture(source, evidence, 'full-row');
      await db.sequelize.query('ALTER TABLE native_capture_files ADD COLUMN unmodeled boolean');
      await expect(db.sequelize.transaction((transaction) => capture.install(transaction))).rejects.toThrow(
        'Native removal capture requires a complete physical source row',
      );
      expect(await rows()).toEqual([]);
    });

    it('does not leave a full-row event behind after a later Repository hook rejects', async () => {
      await installFullRow();
      source.model.addHook('afterBulkDestroy', () => {
        throw new Error('full row rollback');
      });
      await expect(
        db.sequelize.transaction(async (transaction) => {
          await mark(transaction);
          await remove(transaction);
        }),
      ).rejects.toThrow('full row rollback');
      expect(await source.model.count()).toBe(1);
      expect(await rows()).toEqual([]);
    });
  });

  it('verifies a committed installation from a fresh instance without deleting or logging anything', async () => {
    await install();
    const verifier = new files.AttachmentRemovalNativeCapture(source, evidence);
    await db.sequelize.transaction((transaction) => verifier.assertInstalled(transaction));
    expect(await source.model.count()).toBe(1);
    expect(await rows()).toEqual([]);
  });

  it('rejects missing installation without installing it implicitly', async () => {
    capture = new files.AttachmentRemovalNativeCapture(source, evidence);
    await expect(db.sequelize.transaction((transaction) => capture.assertInstalled(transaction))).rejects.toThrow(
      'Native removal capture installation is unavailable or changed',
    );
    const [found] = await db.sequelize.query('SELECT to_regprocedure($function) AS value', {
      bind: { function: `${capture.functionName}()` },
    });
    expect(found).toEqual([{ value: null }]);
    expect(await rows()).toEqual([]);
  });

  it.each([
    ['disabled trigger', 'ALTER TABLE native_capture_files DISABLE TRIGGER tac_remove_capture'],
    ['renamed trigger', 'ALTER TRIGGER tac_remove_capture ON native_capture_files RENAME TO renamed_capture'],
    ['privileged function', (name: string) => `ALTER FUNCTION ${name}() SECURITY DEFINER`],
    ['unsafe search path', (name: string) => `ALTER FUNCTION ${name}() SET search_path = public, pg_catalog`],
    ['strict function', (name: string) => `ALTER FUNCTION ${name}() STRICT`],
    [
      'different trigger function',
      `CREATE FUNCTION cancel_native_capture() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN OLD; END';
        DROP TRIGGER tac_remove_capture ON native_capture_files;
        CREATE TRIGGER tac_remove_capture AFTER DELETE ON native_capture_files
        FOR EACH ROW EXECUTE FUNCTION cancel_native_capture()`,
    ],
    [
      'replaced function body',
      (name: string) =>
        `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS 'BEGIN RETURN OLD; END'`,
    ],
    [
      'conditional trigger',
      (name: string) => `DROP TRIGGER tac_remove_capture ON native_capture_files;
        CREATE TRIGGER tac_remove_capture AFTER DELETE ON native_capture_files
        FOR EACH ROW WHEN (OLD.size < 0) EXECUTE FUNCTION ${name}()`,
    ],
    [
      'statement trigger',
      (name: string) => `DROP TRIGGER tac_remove_capture ON native_capture_files;
        CREATE TRIGGER tac_remove_capture AFTER DELETE ON native_capture_files
        FOR EACH STATEMENT EXECUTE FUNCTION ${name}()`,
    ],
    [
      'trigger arguments',
      (name: string) => `DROP TRIGGER tac_remove_capture ON native_capture_files;
        CREATE TRIGGER tac_remove_capture AFTER DELETE ON native_capture_files
        FOR EACH ROW EXECUTE FUNCTION ${name}('unexpected')`,
    ],
  ])('refuses %s in the actual PostgreSQL catalogs', async (_label, change) => {
    await install();
    await db.sequelize.query(typeof change === 'function' ? change(capture.functionName) : change);
    await expect(db.sequelize.transaction((transaction) => capture.assertInstalled(transaction))).rejects.toThrow(
      'Native removal capture installation is unavailable or changed',
    );
    expect(await source.model.count()).toBe(1);
    expect(await rows()).toEqual([]);
  });

  it('requires the original active root write transaction for verification', async () => {
    await install();
    const transaction = await db.sequelize.transaction();
    await transaction.rollback();
    await expect(capture.assertInstalled(transaction)).rejects.toThrow('active same-database root write transaction');
    await expect(
      db.sequelize.transaction((root) =>
        db.sequelize.transaction({ transaction: root }, (child) => capture.assertInstalled(child)),
      ),
    ).rejects.toThrow('active same-database root write transaction');
    expect(await source.model.count()).toBe(1);
  });

  it('refuses a transaction replication mode that would bypass the installed trigger', async () => {
    await install();
    await expect(
      db.sequelize.transaction(async (transaction) => {
        await db.sequelize.query("SET LOCAL session_replication_role = 'replica'", { transaction });
        await capture.assertInstalled(transaction);
      }),
    ).rejects.toThrow('Native removal capture installation is unavailable or changed');
    expect(await source.model.count()).toBe(1);
    expect(await rows()).toEqual([]);
  });

  it('holds the source table against concurrent trigger DDL until the caller transaction ends', async () => {
    await install();
    let contender: Promise<unknown> | undefined;
    try {
      await db.sequelize.transaction(async (transaction) => {
        await capture.assertInstalled(transaction);
        contender = db.sequelize.query('ALTER TABLE native_capture_files DISABLE TRIGGER tac_remove_capture');
        void contender.catch(() => {});
        await vi.waitFor(
          async () => {
            const [waiting] = await db.sequelize.query(
              "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='ALTER TABLE native_capture_files DISABLE TRIGGER tac_remove_capture'",
            );
            expect(waiting).toHaveLength(1);
          },
          { timeout: 3000, interval: 25 },
        );
        await capture.assertInstalled(transaction);
      });
    } finally {
      await contender;
    }
    await expect(db.sequelize.transaction((transaction) => capture.assertInstalled(transaction))).rejects.toThrow(
      'Native removal capture installation is unavailable or changed',
    );
    expect(await source.model.count()).toBe(1);
  });

  it('records the actual removed tuple without losing bigint keys or replacing repository hooks', async () => {
    await install();
    let after = false;
    source.model.addHook('beforeDestroy', (row) => row.setDataValue('filename', 'memory-only.txt'));
    source.model.addHook('afterDestroy', () => {
      after = true;
    });
    let id: string;
    await db.sequelize.transaction(async (transaction) => {
      id = await mark(transaction);
      expect(await remove(transaction)).toBe(1);
    });
    expect(after).toBe(true);
    const results = await rows();
    expect(results).toHaveLength(1);
    expect(results[0].getDataValue('id')).toBe(id!);
    expect(results[0].getDataValue('payload')).toMatchObject({
      schemaVersion: 1,
      kind: 'attachment-native-delete',
      state: 'deleted-in-transaction',
      source: { schema: 'public', table: 'native_capture_files', primaryField: 'id' },
      record: {
        key: '9007199254740993',
        tenantId: 'B',
        path: 'old/H',
        filename: 'original.txt',
        storageId: '18',
        size: '27',
      },
    });
    expect(results[0].getDataValue('payload').transactionId).toMatch(/^\d+$/);
    expect(await source.model.count()).toBe(0);
  });

  it('captures the persisted location change made by a beforeDestroy hook', async () => {
    await install();
    source.model.addHook('beforeDestroy', async (_row, { transaction }) => {
      await source.model.update({ filename: 'actual.txt' }, { where: {}, hooks: false, transaction });
    });
    await db.sequelize.transaction(async (transaction) => {
      await mark(transaction);
      await remove(transaction);
    });
    expect((await rows())[0].getDataValue('payload').record.filename).toBe('actual.txt');
  });

  it('does not record a SQL-cancelled DELETE despite afterDestroy running', async () => {
    await install();
    let after = false;
    source.model.addHook('afterDestroy', () => {
      after = true;
    });
    await db.sequelize.query(`
      CREATE FUNCTION cancel_native_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER cancel_delete BEFORE DELETE ON native_capture_files
        FOR EACH ROW EXECUTE FUNCTION cancel_native_capture();
    `);
    await db.sequelize.transaction(async (transaction) => {
      await mark(transaction);
      expect(await remove(transaction)).toBe(0);
    });
    expect(after).toBe(true);
    expect(await rows()).toEqual([]);
    expect(await source.model.count()).toBe(1);
  });

  it('rolls back the actual row deletion and native event on a later hook failure', async () => {
    await install();
    source.model.addHook('afterBulkDestroy', () => {
      throw new Error('later hook refused');
    });
    await expect(
      db.sequelize.transaction(async (transaction) => {
        await mark(transaction);
        await remove(transaction);
      }),
    ).rejects.toThrow('later hook refused');
    expect(await rows()).toEqual([]);
    expect(await source.model.count()).toBe(1);
  });

  it('leaves an unmarked repository DELETE unchanged and does not invent evidence', async () => {
    await install();
    await db.sequelize.transaction(remove);
    expect(await rows()).toEqual([]);
    expect(await source.model.count()).toBe(0);
  });

  it('does not reuse the transaction-local operation marker in the next transaction', async () => {
    await install();
    await db.sequelize.transaction(async (transaction) => {
      await mark(transaction);
    });
    await db.sequelize.transaction(remove);
    expect(await rows()).toEqual([]);
    expect(await source.model.count()).toBe(0);
  });

  it('rejects multiple removed rows for one marked operation rather than overwriting its evidence', async () => {
    await install();
    await source.repository.create({
      values: { id: '9007199254740994', path: 'old/H', filename: 'second.txt', storageId: 18, size: 1 },
    });
    await expect(
      db.sequelize.transaction(async (transaction) => {
        await mark(transaction);
        await source.repository.destroy({ filterByTk: ['9007199254740993', '9007199254740994'], transaction });
      }),
    ).rejects.toThrow();
    expect(await source.model.count()).toBe(2);
    expect(await rows()).toEqual([]);
  });

  it('refuses an invalid marker and rolls back deletion', async () => {
    await install();
    await expect(
      db.sequelize.transaction(async (transaction) => {
        await mark(transaction, 'not-an-operation');
        await remove(transaction);
      }),
    ).rejects.toThrow();
    expect(await source.model.count()).toBe(1);
    expect(await rows()).toEqual([]);
  });

  it('does not confuse a native deletion event with absence after a hook recreates the record', async () => {
    await install();
    source.model.addHook('afterDestroy', async (_row, { transaction }) => {
      await source.repository.create({
        values: { id: '9007199254740993', path: 'old/H', filename: 'original.txt', storageId: 18, size: 27 },
        transaction,
      });
    });
    await db.sequelize.transaction(async (transaction) => {
      await mark(transaction);
      await remove(transaction);
    });
    expect(await rows()).toHaveLength(1);
    expect(await source.model.count()).toBe(1);
  });

  it('rolls back explicit installation without leaving a callable capture function', async () => {
    capture = new files.AttachmentRemovalNativeCapture(source, evidence);
    await expect(
      db.sequelize.transaction(async (transaction) => {
        await capture.install(transaction);
        throw new Error('installation rollback');
      }),
    ).rejects.toThrow('installation rollback');
    const [found] = await db.sequelize.query('SELECT to_regprocedure($function) AS value', {
      bind: { function: `${capture.functionName}()` },
    });
    expect(found).toEqual([{ value: null }]);
    await db.sequelize.transaction(async (transaction) => {
      await mark(transaction);
      await remove(transaction);
    });
    expect(await rows()).toEqual([]);
  });

  it('refuses an actual evidence table without its own primary key', async () => {
    capture = new files.AttachmentRemovalNativeCapture(source, evidence);
    await db.sequelize.query('ALTER TABLE native_capture_evidence DROP CONSTRAINT native_capture_evidence_pkey');
    await expect(db.sequelize.transaction((transaction) => capture.install(transaction))).rejects.toThrow();
    expect(await source.model.count()).toBe(1);
    expect(await rows()).toEqual([]);
  });

  it('rejects ownership metadata appearing after a definition captured a source without it', async () => {
    const owner = source.model.rawAttributes.tenantId;
    delete source.model.rawAttributes.tenantId;
    try {
      capture = new files.AttachmentRemovalNativeCapture(source, evidence);
    } finally {
      source.model.rawAttributes.tenantId = owner;
    }
    await expect(db.sequelize.transaction((transaction) => capture.install(transaction))).rejects.toThrow();
    expect(await source.model.count()).toBe(1);
  });

  it('quotes physical table and column identifiers independently of SQL function body delimiters', async () => {
    const quoted = db.collection({
      name: 'quoted_capture_files',
      tableName: 'native_"files$body$',
      schema: 'public',
      template: 'file',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, field: 'primary_\'"key' },
        { name: 'path', type: 'string' },
        { name: 'filename', type: 'string', field: 'stored_\'"name$body$' },
        { name: 'storageId', type: 'integer' },
        { name: 'size', type: 'integer' },
      ],
    });
    // The installed ORM strips embedded identifier quotes in sync/DELETE. This identifier-only
    // case uses explicit SQL fixtures; normal execution/hook cases above use the actual Repository.
    await db.sequelize.query(`CREATE TABLE public."native_""files$body$" (
      "primary_'""key" integer PRIMARY KEY, path text, "stored_'""name$body$" text, "storageId" integer, size integer)`);
    await db.sequelize.query(`INSERT INTO public."native_""files$body$" VALUES (1, 'old/H', $filename, 18, 1)`, {
      bind: { filename: 'literal\'"$body$.txt' },
    });
    capture = new files.AttachmentRemovalNativeCapture(quoted, evidence);
    await db.sequelize.transaction((transaction) => capture.install(transaction));
    await db.sequelize.transaction(async (transaction) => {
      await mark(transaction);
      await db.sequelize.query('DELETE FROM public."native_""files$body$"', { transaction });
    });
    const results = await rows();
    expect(results).toHaveLength(1);
    expect(results[0].getDataValue('payload')).toMatchObject({
      source: { schema: 'public', table: 'native_"files$body$', primaryField: 'primary_\'"key' },
      record: { key: '1', filename: 'literal\'"$body$.txt', tenantId: null },
    });
    expect(await source.model.count()).toBe(1);
  });

  it('does not record a soft deletion as a physical SQL DELETE', async () => {
    const soft = db.collection({
      name: 'soft_capture_files',
      schema: 'public',
      template: 'file',
      paranoid: true,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'path', type: 'string' },
        { name: 'filename', type: 'string' },
        { name: 'storageId', type: 'integer' },
        { name: 'size', type: 'integer' },
      ],
    });
    await soft.model.sync();
    await soft.repository.create({
      values: { id: 1, path: 'old/H', filename: 'retained.txt', storageId: 18, size: 1 },
    });
    capture = new files.AttachmentRemovalNativeCapture(soft, evidence);
    await db.sequelize.transaction((transaction) => capture.install(transaction));
    await db.sequelize.transaction(async (transaction) => {
      await mark(transaction);
      await soft.repository.destroy({ filterByTk: 1, transaction });
    });
    expect(await rows()).toEqual([]);
    expect(await soft.model.findByPk(1)).toBeNull();
    expect((await soft.model.findByPk(1, { paranoid: false })).getDataValue('filename')).toBe('retained.txt');
  });

  it('rejects quoted evidence table names unsupported by the existing evidence structure checker', () => {
    const quotedEvidence = db.collection({
      name: 'quoted_evidence',
      tableName: 'evidence_"name',
      schema: 'public',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'payload', type: 'jsonb' },
      ],
    });
    expect(() => new files.AttachmentRemovalNativeCapture(source, quotedEvidence)).toThrow();
  });
});
