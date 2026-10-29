import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Transaction, type Collection, type Database } from '@tego/server';

import type { LocalAttachmentRemovalObject } from './local-removal-object';
import { AttachmentRemovalNativeCapture } from './native-removal-capture';
import { AttachmentRemovalIntentJournal } from './removal-intent-journal';
import { validateLocalAttachmentRemovalObject } from './removal-object-validation';

export type AttachmentRemovalCompletionObservation =
  | Readonly<{ state: 'unknown' }>
  | Readonly<{ state: 'committed-sql-observed'; operationId: string; transactionId: string }>;

export type AttachmentRemovalObjectObservation =
  | Readonly<{ state: 'unknown' }>
  | Readonly<{
      state: 'committed-object-binding-observed';
      operationId: string;
      transactionId: string;
      object: LocalAttachmentRemovalObject;
    }>;

/**
 * Trusted-server outcome observation, from explicitly independent mappings/pool on the same primary.
 * Owns its transaction and only reads/locks SQL evidence; no schema installation, file I/O, lease,
 * row deletion or operation-state update. A missing/prepared outcome remains unknown, never rollback.
 * inspect reports SQL only; explicit inspectLocalObject adds a historical persisted object snapshot.
 * Neither proves current absence, fresh ACL, causal unforgeability, references or current file identity.
 * Do not expose this internal journal reader as an unauthenticated action.
 */
export class AttachmentRemovalCompletionInspector {
  private readonly database: Database;
  private readonly journal: AttachmentRemovalIntentJournal;
  private readonly native: AttachmentRemovalNativeCapture;
  private readonly endpoint: { host: string; port: number; database: string };
  private readonly objectJournal?: AttachmentRemovalIntentJournal;

  constructor(
    private readonly businessDatabase: Database,
    private readonly source: Collection,
    private readonly intents: Collection,
    private readonly events: Collection,
    private readonly objects?: Collection,
  ) {
    this.database = source.db;
    this.endpoint = this.connection(this.database);
    this.assertIndependentPool();
    if (intents.db !== this.database || events.db !== this.database || intents === events)
      throw new TypeError('Completion inspection requires independent source, intent and event mappings');
    const physical = source.model.getTableName();
    const names = typeof physical === 'string' ? [physical] : [physical.schema, physical.tableName];
    if (names.some((name) => typeof name !== 'string' || name.includes('"')))
      throw new TypeError('Completion inspection requires losslessly quoted source identifiers');
    this.journal = new AttachmentRemovalIntentJournal(intents);
    this.native = new AttachmentRemovalNativeCapture(source, events, 'full-row');
    if (objects !== undefined) {
      if (objects.db !== this.database || [source, intents, events].includes(objects))
        throw new TypeError('Object inspection requires an explicit independent object mapping');
      this.objectJournal = new AttachmentRemovalIntentJournal(objects);
    }
  }

  private connection(database: Database) {
    const { host, port, database: name } = database.options;
    if (
      database.sequelize.getDialect() !== 'postgres' ||
      typeof host !== 'string' ||
      !host ||
      typeof name !== 'string' ||
      !name
    )
      throw new TypeError('Completion inspection requires an independent pool for the same database');
    return { host, port: Number(port || 5432), database: name };
  }

  private assertIndependentPool() {
    if (
      this.database === this.businessDatabase ||
      this.database.sequelize === this.businessDatabase.sequelize ||
      !isDeepStrictEqual(this.connection(this.businessDatabase), this.endpoint) ||
      !isDeepStrictEqual(this.connection(this.database), this.endpoint) ||
      this.source.db !== this.database
    )
      throw new TypeError('Completion inspection requires an independent pool for the same database');
  }

  private table(model: Collection['model']) {
    const generator = this.database.sequelize.getQueryInterface().queryGenerator as unknown as {
      quoteTable(value: unknown): string;
    };
    return generator.quoteTable(model.getTableName());
  }

  private async assertCurrent(transaction: Transaction, withObject = false) {
    this.assertIndependentPool();
    await this.native.assertFullRowInstalled(this.source, transaction);
    await this.journal.assertCompletionJournal(this.source, transaction);
    if (withObject) await this.objectJournal!.assertCompletionJournal(this.source, transaction);
    this.assertIndependentPool();
  }

  private async readObject(operationId: string, completion: Record<string, unknown>, transaction: Transaction) {
    const options = { hooks: false, useMaster: true, transaction, lock: transaction.LOCK.UPDATE };
    const row = await this.objects!.model.unscoped().findByPk(operationId, options);
    if (!row) return undefined;
    const invalid = (): never => {
      throw new TypeError('Removal object binding is invalid or inconsistent');
    };
    const payload = row.getDataValue('payload');
    if (row.getDataValue('id') !== operationId || !payload || typeof payload !== 'object') return invalid();
    const object = validateLocalAttachmentRemovalObject(payload.object);
    const [rows] = await this.database.sequelize.query(
      `SELECT i.oid::text AS intent, ni.nspname::text AS "intentSchema", i.relname::text AS "intentTable",
        o.oid::text AS object, no.nspname::text AS "objectSchema", o.relname::text AS "objectTable",
        pg_catalog.to_regclass($source)::oid::text AS source, pg_catalog.to_regclass($event)::oid::text AS event
      FROM pg_catalog.pg_class i JOIN pg_catalog.pg_namespace ni ON ni.oid=i.relnamespace
      JOIN pg_catalog.pg_class o ON o.oid=pg_catalog.to_regclass($object)
      JOIN pg_catalog.pg_namespace no ON no.oid=o.relnamespace
      WHERE i.oid=pg_catalog.to_regclass($intent)`,
      {
        transaction,
        bind: {
          intent: this.table(this.intents.model),
          object: this.table(this.objects!.model),
          source: this.table(this.source.model),
          event: this.table(this.events.model),
        },
      },
    );
    const physical = (
      rows as {
        intent: string;
        intentSchema: string;
        intentTable: string;
        object: string;
        objectSchema: string;
        objectTable: string;
        source: string;
        event: string;
      }[]
    )[0];
    if (!physical || new Set([physical.intent, physical.object, physical.source, physical.event]).size !== 4)
      return invalid();
    const provenance = (model: Collection['model'], oid: string, schema: string, tableName: string) => ({
      oid,
      schema,
      tableName,
      primaryField: model.rawAttributes.id.field,
      payloadField: model.rawAttributes.payload.field,
    });
    const { completion: _completion, ...prepared } = completion;
    const expected = {
      schemaVersion: 1,
      kind: 'attachment-removal-bound-local-object',
      journal: provenance(this.objects!.model, physical.object, physical.objectSchema, physical.objectTable),
      intent: {
        id: operationId,
        journal: provenance(this.intents.model, physical.intent, physical.intentSchema, physical.intentTable),
        payload: { ...prepared, schemaVersion: 2, state: 'prepared' },
      },
      object,
    };
    const record = completion.record as Record<string, unknown>;
    const storage = completion.storage as Record<string, unknown>;
    const { tenantId: _tenantId, ...location } = record;
    if (
      !isDeepStrictEqual(payload, expected) ||
      object.collectionName !== this.source.name ||
      object.configuredRoot !== storage.root ||
      !isDeepStrictEqual(object.record, location)
    )
      return invalid();
    return object;
  }

  private async expectedHeader(payload: unknown, transaction: Transaction) {
    const object = (value: unknown): value is Record<string, unknown> =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    const key = (value: unknown) =>
      (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isSafeInteger(value));
    if (!object(payload) || !object(payload.record) || !object(payload.storage))
      throw new TypeError('Removal completion payload is invalid');
    const { record, storage } = payload;
    if (
      typeof payload.transactionId !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(payload.transactionId) ||
      !key(record.key) ||
      !key(record.storageId) ||
      typeof record.path !== 'string' ||
      typeof record.filename !== 'string' ||
      !record.filename ||
      !Number.isSafeInteger(record.size) ||
      Number(record.size) < 0 ||
      (record.tenantId !== null && typeof record.tenantId !== 'string') ||
      typeof storage.root !== 'string' ||
      !path.isAbsolute(storage.root) ||
      typeof storage.retainContent !== 'boolean'
    )
      throw new TypeError('Removal completion record or storage metadata is invalid');
    const model = this.source.model;
    const [rows] = await this.database.sequelize.query(
      `SELECT c.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS "tableName"
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid=pg_catalog.to_regclass($table)`,
      { transaction, bind: { table: this.table(model) } },
    );
    const physical = (rows as { oid: string; schema: string; tableName: string }[])[0];
    if (!physical || (rows as unknown[]).length !== 1)
      throw new TypeError('Removal completion physical source is unavailable');
    const source = {
      collectionName: this.source.name,
      table: this.table(model),
      primaryKey: model.primaryKeyAttribute,
      primaryField: model.rawAttributes[model.primaryKeyAttribute].field,
      ownerField: model.rawAttributes.tenantId?.field ?? null,
      ...physical,
    };
    const expected = {
      schemaVersion: 3,
      kind: 'attachment-removal-intent',
      state: 'verified-deleted-in-transaction',
      transactionId: payload.transactionId,
      source,
      record: {
        key: record.key,
        path: record.path,
        filename: record.filename,
        storageId: record.storageId,
        size: record.size,
        tenantId: record.tenantId,
      },
      storage: { root: storage.root, retainContent: storage.retainContent },
      completion: {
        schemaVersion: 1,
        kind: 'attachment-removal-sql-completion',
        nativeCapture: this.native.functionName,
      },
    };
    if (!isDeepStrictEqual(payload, expected))
      throw new TypeError('Removal completion does not match its source and capture definition');
    return {
      schemaVersion: 2,
      kind: 'attachment-native-delete',
      state: 'deleted-in-transaction',
      transactionId: expected.transactionId,
      source: { oid: source.oid, schema: source.schema, table: source.tableName, primaryField: source.primaryField },
      record: {
        ...expected.record,
        key: String(record.key),
        storageId: String(record.storageId),
        size: String(record.size),
      },
    };
  }

  /** Explicit operation id from a trusted server source, not a deletion/recovery/cleanup token. */
  async inspect(operationId: string): Promise<AttachmentRemovalCompletionObservation> {
    return this.inspectEvidence(operationId, false);
  }

  /** Historical SQL/object evidence only. No live filesystem checks, current ACL, references or cleanup right. */
  async inspectLocalObject(operationId: string): Promise<AttachmentRemovalObjectObservation> {
    if (!this.objects || !this.objectJournal)
      throw new TypeError('Object inspection requires an explicit independent object mapping');
    return this.inspectEvidence(operationId, true);
  }

  private inspectEvidence(operationId: string, withObject: false): Promise<AttachmentRemovalCompletionObservation>;
  private inspectEvidence(operationId: string, withObject: true): Promise<AttachmentRemovalObjectObservation>;
  private async inspectEvidence(
    operationId: string,
    withObject: boolean,
  ): Promise<AttachmentRemovalCompletionObservation | AttachmentRemovalObjectObservation> {
    if (typeof operationId !== 'string' || !/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(operationId))
      throw new TypeError('Completion inspection requires an operation identifier');
    this.assertIndependentPool();
    const options = { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE, transaction: null };
    return this.database.sequelize.transaction(options, async (transaction) => {
      const [connections] = await this.database.sequelize.query(
        'SELECT pg_catalog.current_database() AS database, NOT pg_catalog.pg_is_in_recovery() AS primary',
        { transaction },
      );
      const connection = (connections as { database: string; primary: boolean }[])[0];
      if (connection?.database !== this.endpoint.database || connection.primary !== true)
        throw new TypeError('Completion inspection requires the original database primary');
      await this.assertCurrent(transaction, withObject);
      const read = { hooks: false, useMaster: true, transaction, lock: transaction.LOCK.UPDATE };
      const row = await this.intents.model.unscoped().findByPk(operationId, read);
      if (row && row.getDataValue('id') !== operationId)
        throw new TypeError('Removal completion operation identifier does not match its stored row');
      const payload = row?.getDataValue('payload');
      if (
        !row ||
        ((payload?.schemaVersion === 1 || payload?.schemaVersion === 2) &&
          payload?.kind === 'attachment-removal-intent' &&
          payload?.state === 'prepared')
      ) {
        await this.assertCurrent(transaction, withObject);
        return Object.freeze({ state: 'unknown' as const });
      }
      const expected = await this.expectedHeader(payload, transaction);
      await this.native.assertCommittedFullRowMatches(this.source, transaction, operationId, expected);
      if (withObject) {
        const object = await this.readObject(operationId, payload, transaction);
        await this.assertCurrent(transaction, true);
        return object
          ? Object.freeze({
              state: 'committed-object-binding-observed' as const,
              operationId,
              transactionId: expected.transactionId,
              object,
            })
          : Object.freeze({ state: 'unknown' as const });
      }
      await this.assertCurrent(transaction);
      return Object.freeze({
        state: 'committed-sql-observed' as const,
        operationId,
        transactionId: expected.transactionId,
      });
    });
  }
}
