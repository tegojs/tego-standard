import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Transaction, type Collection, type Database } from '@tego/server';

import { lockAttachmentJournalStructure } from './journal-structure';
import { lockAttachmentRemovalReferenceScope } from './removal-reference-scope';

const uuid = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** Internal data from the fixed owned inspector, not a transferable proof or cleanup permission. */
export interface AttachmentRemovalReferenceFenceBinding {
  readonly schemaVersion: 1;
  readonly kind: 'attachment-removal-reference-fence-binding';
  readonly operationId: string;
  readonly transactionId: string;
  readonly references: 0;
  readonly completion: Record<string, unknown>;
  readonly objectBinding: Record<string, unknown>;
  readonly event: { readonly oid: string; readonly table: string; readonly key: string; readonly payload: string };
}

/** A durable denial of retries, not evidence of execution or a transferable cleanup permission. */
export interface AttachmentRemovalCleanupAttempt {
  readonly schemaVersion: 1;
  readonly kind: 'attachment-removal-cleanup-attempt';
  readonly state: 'unresolved';
  readonly operationId: string;
  readonly attemptId: string;
  readonly transactionId: string;
  readonly reservation: AttachmentRemovalReferenceFenceBinding;
}

/**
 * Explicit, conservative database write isolation, not ACL or cleanup permission. Installation is
 * opt-in schema work; construction does no SQL. A reservation permanently closes ALL registered
 * file-table and storage-configuration DML, including unrelated rows. No release/expiry API exists:
 * reopening would let old client paths be reintroduced. This is not a per-object writer protocol.
 *
 * Every guarded statement updates a pre-existing permanent row, including while open, so an older
 * repeatable-read snapshot cannot miss a committed reservation. Open writes serialize on that row.
 * Requires trusted schema owners (including functions), registered mappings and normal PostgreSQL
 * trigger enforcement. Does not protect unmapped tables, schema owners or filesystem writers.
 * No inspector, deletion executor, runtime registration or file I/O is wired here.
 */
export class AttachmentRemovalReferenceWriteFence {
  readonly functionName: string;
  private readonly sources: readonly Collection[];
  private readonly mapped: {
    collection: Collection;
    model: Collection['model'];
    name: string;
    table: string;
    attributes: { name: string; attribute: object; field: string; type: string }[];
  }[];
  private readonly triggerName: string;
  private readonly key = 'attachment-removal-reference-fence-v1';

  constructor(
    private readonly database: Database,
    sources: readonly Collection[],
    private readonly storages: Collection,
    private readonly journal: Collection,
  ) {
    this.sources = Object.freeze([...sources].sort((left, right) => left.name.localeCompare(right.name)));
    this.mapped = [...this.sources, storages, journal].map((collection) => {
      const model = collection?.model;
      const physical = model?.getTableName();
      const names = typeof physical === 'string' ? [physical] : [physical?.schema, physical?.tableName];
      if (
        !model ||
        names.some((value) => typeof value !== 'string' || !value || value.includes('"')) ||
        Object.values(model.rawAttributes).some((attribute) => !attribute.field || attribute.field.includes('"'))
      )
        throw new TypeError('Removal reference fence metadata is unavailable or changed');
      return {
        collection,
        model,
        name: collection.name,
        table: this.generator().quoteTable(physical),
        attributes: Object.entries(model.rawAttributes).map(([name, attribute]) => ({
          name,
          attribute,
          field: attribute.field,
          type: String(attribute.type),
        })),
      };
    });
    const hash = createHash('sha256')
      .update(JSON.stringify(this.mapped.map(({ name, table }) => ({ name, table }))))
      .digest('hex')
      .slice(0, 20);
    const physical = journal.model.getTableName();
    if (typeof physical !== 'object' || !physical.schema)
      throw new TypeError('Removal reference fence requires an explicitly qualified journal');
    this.triggerName = `tac_reference_fence_${hash}`;
    this.functionName = `${this.quote(physical.schema)}.${this.quote(this.triggerName)}`;
    this.assertMetadata();
  }

  private generator() {
    return this.database.sequelize.getQueryInterface().queryGenerator as unknown as {
      quoteTable(table: unknown): string;
      escape(value: string): string;
    };
  }

  private quote(value: string) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  private assertMetadata() {
    const model = this.journal.model;
    if (
      this.database.sequelize.getDialect() !== 'postgres' ||
      this.storages !== this.database.collections.get('storages') ||
      new Set(this.mapped.map(({ table }) => table)).size !== this.mapped.length ||
      this.mapped.some(
        ({ collection, model, name, table, attributes }) =>
          collection.db !== this.database ||
          this.database.collections.get(name) !== collection ||
          collection.name !== name ||
          collection.model !== model ||
          this.database.modelCollection.get(model) !== collection ||
          this.generator().quoteTable(model.getTableName()) !== table ||
          Object.keys(model.rawAttributes).length !== attributes.length ||
          attributes.some(
            ({ name, attribute, field, type }) =>
              model.rawAttributes[name] !== attribute ||
              model.rawAttributes[name].field !== field ||
              String(model.rawAttributes[name].type) !== type,
          ),
      ) ||
      model.primaryKeyAttributes.length !== 1 ||
      model.primaryKeyAttribute !== 'id' ||
      Object.keys(model.rawAttributes).length !== 2 ||
      !['STRING', 'TEXT'].includes((model.rawAttributes.id?.type as { key?: string })?.key) ||
      (model.rawAttributes.payload?.type as { key?: string })?.key !== 'JSONB' ||
      ['id', 'payload'].some((key) => {
        const attribute = model.rawAttributes[key];
        return attribute?.get || attribute?.set || attribute?.references || attribute?.defaultValue !== undefined;
      })
    )
      throw new TypeError('Removal reference fence metadata is unavailable or changed');
  }

  private query(sql: string, transaction: Transaction, bind?: Record<string, unknown>) {
    // With no bind, omit it entirely: the old ORM also scans dollar literals in an empty bind.
    return this.database.sequelize.query(sql, bind ? { transaction, bind } : { transaction });
  }

  private async context(transaction: Transaction) {
    this.assertMetadata();
    // The complete source/storage LOCK remains first SQL for a fresh coordinating transaction.
    const scope = await lockAttachmentRemovalReferenceScope(this.database, this.sources, this.storages, transaction);
    const entry = this.mapped.at(-1)!;
    const key = this.journal.model.rawAttributes.id.field;
    const payload = this.journal.model.rawAttributes.payload.field;
    await lockAttachmentJournalStructure(
      this.database,
      entry.model,
      [key, payload],
      transaction,
      'Removal reference fence requires an independent two-column journal',
    );
    const [rows] = await this.query(
      `SELECT c.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS "tableName",
        (c.relkind='r' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype NOT IN ('p','u'))
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attrdef d WHERE d.adrelid=c.oid)
          AND (SELECT a.atttypid IN ('pg_catalog.text'::regtype,'pg_catalog.varchar'::regtype)
            FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attname=$key)
          AND (SELECT a.atttypid='pg_catalog.jsonb'::regtype
            FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attname=$payload)) AS valid
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.oid=pg_catalog.to_regclass($table)`,
      transaction,
      { table: entry.table, key, payload },
    );
    this.assertMetadata();
    const physical = (rows as { oid: string; schema: string; tableName: string; valid: boolean }[])[0];
    if (!physical?.valid || [scope.storage, ...scope.sources].some(({ oid }) => oid === physical.oid))
      throw new TypeError('Removal reference fence journal has unsupported physical behavior');
    const base = {
      schemaVersion: 1,
      kind: 'attachment-removal-reference-write-fence',
      journal: { oid: physical.oid, schema: physical.schema, tableName: physical.tableName, key, payload },
      sources: scope.sources,
      storage: scope.storage,
    };
    const literal = (value: string) => this.generator().escape(value);
    const table = `${this.quote(physical.schema)}.${this.quote(physical.tableName)}`;
    const body = `
DECLARE observed jsonb;
BEGIN
  UPDATE ${table} SET ${this.quote(payload)}=${this.quote(payload)}
    WHERE ${this.quote(key)}=${literal(this.key)} RETURNING ${this.quote(payload)} INTO observed;
  IF NOT FOUND OR observed IS NULL OR
    observed - 'reservation' IS DISTINCT FROM ${literal(JSON.stringify(base))}::jsonb OR
    NOT (observed ? 'reservation') OR jsonb_typeof(observed->'reservation') IS DISTINCT FROM 'null'
  THEN RAISE EXCEPTION 'Attachment removal reference writes are fenced'; END IF;
  RETURN NULL;
END`;
    return { scope, base, body, table, key: this.quote(key), payload: this.quote(payload) };
  }

  private async assertDefinition(
    context: Awaited<ReturnType<AttachmentRemovalReferenceWriteFence['context']>>,
    tx: Transaction,
  ) {
    const [functions] = await this.query(
      `SELECT p.oid::text AS oid, p.prosrc AS body,
        (NOT p.prosecdef AND NOT p.proleakproof AND p.provolatile='v' AND p.prokind='f'
          AND p.pronargs=0 AND p.prorettype='pg_catalog.trigger'::regtype
          AND l.lanname='plpgsql' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]) AS valid
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE p.oid=pg_catalog.to_regprocedure($function)`,
      tx,
      { function: `${this.functionName}()` },
    );
    const definition = (functions as { oid: string; body: string; valid: boolean }[])[0];
    if (!definition?.valid || definition.body !== context.body)
      throw new TypeError('Removal reference fence installation changed');
    for (const table of [...context.scope.sources, context.scope.storage]) {
      const [rows] = await this.query(
        `SELECT (t.tgfoid=$function::oid AND t.tgtype=62 AND t.tgenabled='A' AND NOT t.tgisinternal
          AND t.tgconstraint=0 AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgparentid=0) AS valid
        FROM pg_catalog.pg_trigger t WHERE t.tgrelid=$table::oid AND t.tgname=$trigger`,
        tx,
        { function: definition.oid, table: table.oid, trigger: this.triggerName },
      );
      if ((rows as { valid: boolean }[]).length !== 1 || (rows as { valid: boolean }[])[0]?.valid !== true)
        throw new TypeError('Removal reference fence installation changed');
    }
    this.assertMetadata();
    await context.scope.assertCurrent();
  }

  private async state(context: Awaited<ReturnType<AttachmentRemovalReferenceWriteFence['context']>>, tx: Transaction) {
    // An actual update rejects stale snapshots, unlike a SELECT or a newly inserted tombstone.
    const [rows] = await this.query(
      `UPDATE ${context.table} SET ${context.payload}=${context.payload}
       WHERE ${context.key}=${this.generator().escape(this.key)} RETURNING ${context.payload} AS payload`,
      tx,
    );
    return this.parseState(context, rows);
  }

  private parseState(context: Awaited<ReturnType<AttachmentRemovalReferenceWriteFence['context']>>, rows: unknown) {
    const payload = (rows as { payload: Record<string, unknown> }[])[0]?.payload;
    const { reservation, binding, attempt, ...base } = payload && typeof payload === 'object' ? payload : {};
    if (
      !isDeepStrictEqual(base, context.base) ||
      !(reservation === null || (typeof reservation === 'string' && uuid.test(reservation)))
    )
      throw new TypeError('Removal reference fence state is invalid');
    if (binding !== undefined) this.assertBinding(binding, reservation as string);
    if (attempt !== undefined) this.assertAttempt(attempt, binding);
    return {
      reservation: reservation as string | null,
      binding: binding as AttachmentRemovalReferenceFenceBinding | undefined,
      attempt: attempt as AttachmentRemovalCleanupAttempt | undefined,
    };
  }

  private assertAttempt(value: unknown, binding: unknown): asserts value is AttachmentRemovalCleanupAttempt {
    const attempt = value as AttachmentRemovalCleanupAttempt | undefined;
    if (
      !attempt ||
      typeof attempt !== 'object' ||
      Array.isArray(attempt) ||
      !binding ||
      attempt.schemaVersion !== 1 ||
      attempt.kind !== 'attachment-removal-cleanup-attempt' ||
      attempt.state !== 'unresolved' ||
      typeof attempt.operationId !== 'string' ||
      attempt.operationId.length !== 36 ||
      !uuid.test(attempt.operationId) ||
      typeof attempt.attemptId !== 'string' ||
      attempt.attemptId.length !== 36 ||
      !uuid.test(attempt.attemptId) ||
      attempt.attemptId === attempt.operationId ||
      typeof attempt.transactionId !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(attempt.transactionId) ||
      !isDeepStrictEqual(attempt.reservation, binding) ||
      attempt.operationId !== attempt.reservation.operationId ||
      attempt.transactionId === attempt.reservation.transactionId ||
      attempt.transactionId === attempt.reservation.completion.transactionId ||
      !isDeepStrictEqual(Object.keys(attempt).sort(), [
        'attemptId',
        'kind',
        'operationId',
        'reservation',
        'schemaVersion',
        'state',
        'transactionId',
      ])
    )
      throw new TypeError('Removal cleanup attempt is invalid');
  }

  private assertBinding(value: unknown, operationId: string): asserts value is AttachmentRemovalReferenceFenceBinding {
    const object = (value: unknown): value is Record<string, unknown> =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    if (
      !object(value) ||
      !uuid.test(operationId || '') ||
      value.schemaVersion !== 1 ||
      value.kind !== 'attachment-removal-reference-fence-binding' ||
      value.operationId !== operationId ||
      typeof value.transactionId !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(value.transactionId) ||
      value.references !== 0 ||
      !object(value.completion) ||
      !object(value.objectBinding) ||
      !object(value.event) ||
      typeof value.event.oid !== 'string' ||
      !/^[1-9]\d*$/.test(value.event.oid) ||
      ['table', 'key', 'payload'].some((key) => typeof value.event[key] !== 'string' || !value.event[key]) ||
      !isDeepStrictEqual(Object.keys(value.event).sort(), ['key', 'oid', 'payload', 'table']) ||
      !isDeepStrictEqual(Object.keys(value).sort(), [
        'completion',
        'event',
        'kind',
        'objectBinding',
        'operationId',
        'references',
        'schemaVersion',
        'transactionId',
      ])
    )
      throw new TypeError('Removal reference fence binding is invalid');
  }

  /** Explicit transactional schema installation only. Never replaces an existing gate or function. */
  async install(transaction: Transaction): Promise<void> {
    const context = await this.context(transaction);
    await this.query(
      `CREATE FUNCTION ${this.functionName}() RETURNS trigger LANGUAGE plpgsql
       SECURITY INVOKER SET search_path=pg_catalog AS ${this.generator().escape(context.body)}`,
      transaction,
    );
    for (const table of [...context.scope.sources, context.scope.storage]) {
      const name = `${this.quote(table.schema)}.${this.quote(table.tableName)}`;
      await this.query(
        `CREATE TRIGGER ${this.quote(this.triggerName)} BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${name}
         FOR EACH STATEMENT EXECUTE FUNCTION ${this.functionName}()`,
        transaction,
      );
      await this.query(`ALTER TABLE ${name} ENABLE ALWAYS TRIGGER ${this.quote(this.triggerName)}`, transaction);
    }
    await this.query(
      `INSERT INTO ${context.table} (${context.key},${context.payload}) VALUES
       (${this.generator().escape(this.key)},${this.generator().escape(JSON.stringify({ ...context.base, reservation: null }))}::jsonb)`,
      transaction,
    );
    await this.assertDefinition(context, transaction);
    if ((await this.state(context, transaction)).reservation !== null)
      throw new TypeError('Removal reference fence state is invalid');
  }

  /** Current installation/state check; updates only the coordination row, never business data. */
  async assertInstalled(transaction: Transaction): Promise<void> {
    const context = await this.context(transaction);
    await this.assertDefinition(context, transaction);
    await this.state(context, transaction);
    await this.assertDefinition(context, transaction);
  }

  /** Locked durable data only; does not update state or verify the binding's evidence/commit claims. */
  async readBinding(transaction: Transaction): Promise<AttachmentRemovalReferenceFenceBinding | undefined> {
    return (await this.readState(transaction)).binding;
  }

  /** Locked stored data, not verification of an attempt's causal origin, commit or permission to act. */
  async readAttempt(transaction: Transaction): Promise<AttachmentRemovalCleanupAttempt | undefined> {
    return (await this.readState(transaction)).attempt;
  }

  private async readState(transaction: Transaction) {
    const context = await this.context(transaction);
    await this.assertDefinition(context, transaction);
    const [rows] = await this.query(
      `SELECT ${context.payload} AS payload FROM ${context.table}
       WHERE ${context.key}=${this.generator().escape(this.key)} FOR UPDATE`,
      transaction,
    );
    const state = this.parseState(context, rows);
    await this.assertDefinition(context, transaction);
    return state;
  }

  /** Internal one-shot persistence; only the fixed owned inspector verifies the actual evidence. */
  async persistAttempt(attempt: AttachmentRemovalCleanupAttempt, transaction: Transaction): Promise<void> {
    const captured = structuredClone(attempt);
    const context = await this.context(transaction);
    await this.assertDefinition(context, transaction);
    const before = await this.readState(transaction);
    if (before.attempt) throw new TypeError('Removal cleanup attempt is already recorded');
    this.assertAttempt(captured, before.binding);
    const [rows] = await this.query('SELECT pg_catalog.txid_current()::text AS xid', transaction);
    if ((rows as { xid: string }[])[0]?.xid !== captured.transactionId)
      throw new TypeError('Removal cleanup attempt requires its original coordinating transaction');
    await this.query(
      `UPDATE ${context.table} SET ${context.payload}=
       ${this.generator().escape(JSON.stringify({ ...context.base, reservation: before.reservation, binding: before.binding, attempt: captured }))}::jsonb
       WHERE ${context.key}=${this.generator().escape(this.key)}`,
      transaction,
    );
    const after = await this.readState(transaction);
    if (!isDeepStrictEqual(after, { ...before, attempt: captured }))
      throw new TypeError('Removal cleanup attempt evidence changed');
    await this.assertDefinition(context, transaction);
  }

  /**
   * Denial-only UUID association, not verification of that removal or a committed cleanup permit.
   * Caller owns commit/rollback; an uncertain commit must leave this reservation unresolved.
   */
  async reserve(operationId: string, transaction: Transaction) {
    return this.close(operationId, transaction);
  }

  /**
   * Internal persistence after the owned inspector's actual checks, not validation of arbitrary
   * supplied evidence. Stored binding must be independently reverified before any future cleanup.
   * Does not upgrade an earlier bare reservation or grant authority beyond closing database writes.
   */
  async reserveWithEvidence(binding: AttachmentRemovalReferenceFenceBinding, transaction: Transaction) {
    const captured = structuredClone(binding);
    this.assertBinding(captured, captured?.operationId);
    return this.close(captured.operationId, transaction, captured);
  }

  private async close(operationId: string, transaction: Transaction, binding?: AttachmentRemovalReferenceFenceBinding) {
    if (typeof operationId !== 'string' || !uuid.test(operationId))
      throw new TypeError('Removal reference fence requires a valid operation UUID');
    const context = await this.context(transaction);
    await this.assertDefinition(context, transaction);
    if ((await this.state(context, transaction)).reservation !== null)
      throw new TypeError('Removal reference fence is already reserved');
    if (binding) {
      const [rows] = await this.query('SELECT pg_catalog.txid_current()::text AS xid', transaction);
      if ((rows as { xid: string }[])[0]?.xid !== binding.transactionId)
        throw new TypeError('Removal reference fence binding requires its original coordinating transaction');
    }
    await this.query(
      `UPDATE ${context.table} SET ${context.payload}=
       ${this.generator().escape(JSON.stringify({ ...context.base, reservation: operationId, ...(binding ? { binding } : {}) }))}::jsonb
       WHERE ${context.key}=${this.generator().escape(this.key)}`,
      transaction,
    );
    const actual = await this.state(context, transaction);
    if (actual.reservation !== operationId || !isDeepStrictEqual(actual.binding, binding))
      throw new TypeError('Removal reference fence state is invalid');
    await this.assertDefinition(context, transaction);
    return Object.freeze({ state: 'reference-writes-fenced-in-transaction' as const, operationId });
  }
}
