import { createHash } from 'node:crypto';
import { Transaction, type Collection, type Database } from '@tego/server';

import { lockAttachmentJournalStructure } from './journal-structure';

interface PhysicalTable {
  schema: string;
  tableName: string;
}

/**
 * Optional SQL event capture, explicitly installed by a trusted schema migration only.
 * Not an ACL/G check, a committed deletion proof, an intent verifier or cleanup authority.
 * No registration, schema changes, DELETE or file I/O occurs on construction.
 */
export class AttachmentRemovalNativeCapture {
  readonly setting = 'tego.attachment_removal_capture';
  readonly functionName: string;
  private readonly database: Database;
  private readonly sourceModel: Collection['model'];
  private readonly evidenceModel: Collection['model'];
  private readonly sourceTable: PhysicalTable;
  private readonly evidenceTable: PhysicalTable;
  private readonly fields: { key: string; column: string; attribute: object; type: string }[];
  private readonly evidenceFields: { key: string; column: string; attribute: object; type: string }[];

  constructor(
    private readonly source: Collection,
    private readonly evidence: Collection,
  ) {
    this.database = source.db;
    this.sourceModel = source.model;
    this.evidenceModel = evidence.model;
    this.sourceTable = this.physical(this.sourceModel);
    this.evidenceTable = this.physical(this.evidenceModel);
    const capture = (model: Collection['model'], keys: string[]) =>
      keys.map((key) => {
        const attribute = model.rawAttributes[key];
        if (!attribute || !attribute.field || (attribute.type as { key?: string }).key === 'VIRTUAL')
          throw new TypeError('Native removal capture requires physical location and evidence fields');
        return { key, column: attribute.field, attribute, type: String(attribute.type) };
      });
    this.fields = capture(this.sourceModel, [
      this.sourceModel.primaryKeyAttribute,
      'path',
      'filename',
      'storageId',
      'size',
      ...(this.sourceModel.rawAttributes.tenantId ? ['tenantId'] : []),
    ]);
    this.evidenceFields = capture(this.evidenceModel, ['id', 'payload']);
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          source: this.sourceTable,
          evidence: this.evidenceTable,
          fields: this.fields.map(({ key, column }) => ({ key, column })),
        }),
      )
      .digest('hex')
      .slice(0, 20);
    this.functionName = `${this.quote(this.evidenceTable.schema)}.${this.quote(`tac_remove_capture_${hash}`)}`;
    this.assertCurrent();
  }

  private physical(model: Collection['model']): PhysicalTable {
    const table = model.getTableName();
    if (!table || typeof table !== 'object' || typeof table.schema !== 'string' || !table.schema || !table.tableName)
      throw new TypeError('Native removal capture requires explicitly qualified physical tables');
    return { schema: table.schema, tableName: table.tableName };
  }

  private generator() {
    return this.database.sequelize.getQueryInterface().queryGenerator as unknown as {
      escape(value: string): string;
    };
  }

  private quote(value: string) {
    // This PG-only primitive must preserve embedded quotes, unlike the installed ORM renderer.
    return `"${value.replaceAll('"', '""')}"`;
  }
  private table(value: PhysicalTable) {
    return `${this.quote(value.schema)}.${this.quote(value.tableName)}`;
  }

  private assertCurrent() {
    const { database, source, evidence, sourceModel, evidenceModel } = this;
    const sameFields = (model: Collection['model'], fields: typeof this.fields) =>
      fields.every(
        ({ key, column, attribute, type }) =>
          model.rawAttributes[key] === attribute &&
          model.rawAttributes[key].field === column &&
          String(model.rawAttributes[key].type) === type,
      );
    if (
      database.sequelize.getDialect() !== 'postgres' ||
      source.db !== database ||
      evidence.db !== database ||
      database.getCollection(source.name) !== source ||
      database.getCollection(evidence.name) !== evidence ||
      source.model !== sourceModel ||
      evidence.model !== evidenceModel ||
      database.modelCollection.get(sourceModel) !== source ||
      database.modelCollection.get(evidenceModel) !== evidence ||
      source.options.template !== 'file' ||
      sourceModel.primaryKeyAttributes.length !== 1 ||
      sourceModel.primaryKeyAttribute !== this.fields[0].key ||
      Boolean(sourceModel.rawAttributes.tenantId) !== this.fields.some(({ key }) => key === 'tenantId') ||
      evidenceModel.primaryKeyAttributes.length !== 1 ||
      evidenceModel.primaryKeyAttribute !== 'id' ||
      Object.keys(evidenceModel.rawAttributes).length !== 2 ||
      !sameFields(sourceModel, this.fields) ||
      !sameFields(evidenceModel, this.evidenceFields) ||
      JSON.stringify(this.physical(sourceModel)) !== JSON.stringify(this.sourceTable) ||
      JSON.stringify(this.physical(evidenceModel)) !== JSON.stringify(this.evidenceTable) ||
      this.table(this.sourceTable) === this.table(this.evidenceTable) ||
      // The shared structure checker still uses the installed ORM's table renderer. Fail closed
      // instead of validating a different, stripped evidence table name.
      [this.evidenceTable.schema, this.evidenceTable.tableName].some((name) => name.includes('"')) ||
      this.evidenceFields.some(({ key }) => {
        const attr = evidenceModel.rawAttributes[key];
        const type = (attr.type as { key?: string }).key;
        return (
          attr.get ||
          attr.set ||
          attr.references ||
          !(key === 'payload' ? ['JSON', 'JSONB'] : ['STRING', 'TEXT']).includes(type)
        );
      })
    )
      throw new TypeError('Native removal capture metadata is unavailable or changed');
  }

  private async lockStructures(transaction: Transaction, mode: 'ROW EXCLUSIVE' | 'SHARE ROW EXCLUSIVE') {
    this.assertCurrent();
    const state = transaction as Transaction & {
      sequelize?: Database['sequelize'];
      finished?: string;
      parent?: Transaction;
      options?: { readOnly?: boolean };
    };
    if (
      !(transaction instanceof Transaction) ||
      state.sequelize !== this.database.sequelize ||
      state.finished ||
      state.parent ||
      state.options?.readOnly
    )
      throw new TypeError('Native capture requires an active same-database root write transaction');
    await lockAttachmentJournalStructure(
      this.database,
      this.evidenceModel,
      this.evidenceFields.map(({ column }) => column),
      transaction,
      'Native capture evidence requires an independent primary key and no references or extra columns',
    );
    const source = this.table(this.sourceTable);
    await this.database.sequelize.query(`LOCK TABLE ${source} IN ${mode} MODE`, { transaction });
    const [rows] = await this.database.sequelize.query(
      `SELECT
      c.relkind::text AS kind,
      ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited,
      EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=k.conkey[1]
        WHERE k.conrelid=c.oid AND k.contype='p' AND array_length(k.conkey,1)=1 AND a.attname=$key) AS primary
      FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($table)`,
      { transaction, bind: { table: source, key: this.fields[0].column } },
    );
    const physical = (rows as { kind: string; columns: string[]; inherited: boolean; primary: boolean }[])[0];
    this.assertCurrent();
    if (
      !physical ||
      physical.kind !== 'r' ||
      physical.inherited ||
      !physical.primary ||
      this.fields.some(({ column }) => !physical.columns.includes(column))
    )
      throw new TypeError(
        'Native removal capture requires an ordinary physical source with its expected primary key and fields',
      );
  }

  private functionBody() {
    const evidence = this.table(this.evidenceTable);
    const literal = (value: string) => this.generator().escape(value);
    const original = (key: string) => {
      const field = this.fields.find((field) => field.key === key);
      return field ? `pg_catalog.to_jsonb(OLD)->>${literal(field.column)}` : 'NULL::text';
    };
    return `DECLARE operation_id text;
      BEGIN
        operation_id := pg_catalog.current_setting(${literal(this.setting)}, true);
        IF operation_id IS NULL OR operation_id = '' THEN RETURN OLD; END IF;
        IF operation_id !~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'Invalid attachment removal capture identifier';
        END IF;
        INSERT INTO ${evidence} (${this.quote(this.evidenceFields[0].column)}, ${this.quote(this.evidenceFields[1].column)})
        VALUES (operation_id, pg_catalog.jsonb_build_object(
          'schemaVersion', 1, 'kind', 'attachment-native-delete', 'state', 'deleted-in-transaction',
          'transactionId', pg_catalog.txid_current()::text,
          'source', pg_catalog.jsonb_build_object('oid', TG_RELID::text, 'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'primaryField', ${literal(this.fields[0].column)}),
          'record', pg_catalog.jsonb_build_object('key', ${original(this.fields[0].key)}, 'path', ${original('path')},
            'filename', ${original('filename')}, 'storageId', ${original('storageId')}, 'size', ${original('size')}, 'tenantId', ${original('tenantId')})));
        RETURN OLD;
      END`;
  }

  /** Explicit schema installation in the supplied same-database top-level write transaction. */
  async install(transaction: Transaction): Promise<void> {
    await this.lockStructures(transaction, 'SHARE ROW EXCLUSIVE');
    const literal = (value: string) => this.generator().escape(value);
    // No OR REPLACE: installation may never silently replace another function or trigger.
    await this.database.sequelize.query(
      `CREATE FUNCTION ${this.functionName}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS ${literal(this.functionBody())}`,
      { transaction },
    );
    await this.database.sequelize.query(
      `CREATE TRIGGER ${this.quote('tac_remove_capture')} AFTER DELETE ON ${this.table(this.sourceTable)} FOR EACH ROW EXECUTE FUNCTION ${this.functionName}()`,
      { transaction },
    );
    this.assertCurrent();
  }

  /**
   * Point-in-time catalog verification only; never installs, deletes or blesses an event.
   * Table locks prevent concurrent table/trigger DDL, not replacement of a function by its owner.
   * A later consumer must recheck and separately validate intent, authorization and actual events.
   */
  async assertInstalled(transaction: Transaction): Promise<void> {
    await this.lockStructures(transaction, 'ROW EXCLUSIVE');
    const [rows] = await this.database.sequelize.query(
      `SELECT p.prosrc AS body,
        (l.lanname='plpgsql' AND p.prokind='f' AND p.pronargs=0 AND p.pronargdefaults=0
          AND p.prorettype='pg_catalog.trigger'::pg_catalog.regtype AND NOT p.proretset
          AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof
          AND p.provolatile='v' AND p.proparallel='u'
          AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
          AND pg_catalog.current_setting('session_replication_role')='origin'
          AND t.tgfoid=p.oid AND t.tgtype=9 AND t.tgenabled='O'
          AND NOT t.tgisinternal AND t.tgparentid=0 AND t.tgconstraint=0
          AND NOT t.tgdeferrable AND NOT t.tginitdeferred
          AND t.tgnargs=0 AND pg_catalog.octet_length(t.tgargs)=0
          AND t.tgqual IS NULL AND t.tgattr::text=''
          AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL) AS valid
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      LEFT JOIN pg_catalog.pg_trigger t ON t.tgrelid=pg_catalog.to_regclass($source) AND t.tgname='tac_remove_capture'
      WHERE p.oid=pg_catalog.to_regprocedure($function)`,
      {
        transaction,
        bind: { source: this.table(this.sourceTable), function: `${this.functionName}()` },
      },
    );
    this.assertCurrent();
    const result = (rows as { body: string; valid: boolean }[])[0];
    if (!result || result.valid !== true || result.body !== this.functionBody())
      throw new TypeError('Native removal capture installation is unavailable or changed');
  }
}
