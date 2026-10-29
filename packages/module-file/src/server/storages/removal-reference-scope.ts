import { isDeepStrictEqual } from 'node:util';
import { Transaction, type Collection, type Database } from '@tego/server';

import type { LocalAttachmentRemovalObject } from './local-removal-object';
import {
  observeMappedLocalRemovalReferences,
  type AttachmentRemovalReferenceObservation,
} from './removal-reference-observation';

export interface AttachmentRemovalReferenceTable {
  readonly collectionName: string;
  readonly oid: string;
  readonly schema: string;
  readonly tableName: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface AttachmentRemovalReferenceScope {
  readonly sources: readonly AttachmentRemovalReferenceTable[];
  readonly storage: AttachmentRemovalReferenceTable;
  assertCurrent(): Promise<void>;
  observeLocalObject(object: LocalAttachmentRemovalObject): Promise<AttachmentRemovalReferenceObservation>;
}

/**
 * Trusted-server coordination primitive for a later fixed reference inspector. Holds SHARE table
 * locks until the caller's original transaction ends, including storage root configuration.
 * Covers this instance's explicit registered file models, not arbitrary unregistered SQL tables,
 * external sources or filesystem writers. Does not read business rows, inspect files, certify no
 * references or authorize cleanup. The caller must not mutate these facts in its own transaction.
 */
export async function lockAttachmentRemovalReferenceScope(
  database: Database,
  sources: readonly Collection[],
  storages: Collection,
  transaction: Transaction,
): Promise<AttachmentRemovalReferenceScope> {
  const assertTransaction = () => {
    const state = transaction as Transaction & {
      sequelize?: typeof database.sequelize;
      parent?: Transaction;
      finished?: string;
      options?: { readOnly?: boolean; isolationLevel?: string };
    };
    if (
      !(transaction instanceof Transaction) ||
      database.sequelize.getDialect() !== 'postgres' ||
      state.sequelize !== database.sequelize ||
      state.parent ||
      state.finished ||
      state.options?.readOnly ||
      state.options?.isolationLevel !== Transaction.ISOLATION_LEVELS.SERIALIZABLE
    )
      throw new TypeError('Removal reference scope requires its active serializable transaction');
  };
  assertTransaction();
  const registered = () => [...database.collections.values()].filter((value) => value.options.template === 'file');
  const capturedSources = [...sources];
  const registry = registered();
  if (
    !capturedSources.length ||
    new Set(capturedSources).size !== capturedSources.length ||
    registry.length !== capturedSources.length ||
    registry.some((value) => !capturedSources.includes(value))
  )
    throw new TypeError('Removal reference scope requires every registered file collection exactly once');

  const generator = database.sequelize.getQueryInterface().queryGenerator as unknown as {
    quoteTable(table: unknown): string;
    quoteIdentifier(name: string): string;
  };
  const nativeTypes: Record<string, string> = {
    STRING: 'varchar',
    CHAR: 'bpchar',
    TEXT: 'text',
    UUID: 'uuid',
    SMALLINT: 'int2',
    INTEGER: 'int4',
    BIGINT: 'int8',
    JSON: 'json',
    JSONB: 'jsonb',
  };
  const nativeType = (attribute: Collection['model']['rawAttributes'][string]) =>
    nativeTypes[(attribute.type as unknown as { key: string }).key];
  const capture = (collection: Collection, names: string[]) => {
    const model = collection?.model;
    const table = model?.getTableName();
    const identifiers = typeof table === 'string' ? [table] : [table?.schema, table?.tableName];
    if (
      collection?.db !== database ||
      database.collections.get(collection.name) !== collection ||
      database.modelCollection.get(model) !== collection ||
      identifiers.some((name) => typeof name !== 'string' || !name || name.includes('"')) ||
      names.some((name) => {
        const attribute = model.rawAttributes[name];
        return !attribute || !attribute.field || attribute.field.includes('"') || !nativeType(attribute);
      })
    )
      throw new TypeError('Removal reference scope metadata changed');
    return {
      collection,
      model,
      name: collection.name,
      table: generator.quoteTable(table),
      attributes: names.map((name) => ({
        name,
        attribute: model.rawAttributes[name],
        field: model.rawAttributes[name].field as string,
        type: String(model.rawAttributes[name].type),
        nativeType: nativeType(model.rawAttributes[name]),
      })),
    };
  };
  if (storages !== database.collections.get('storages') || capturedSources.includes(storages))
    throw new TypeError('Removal reference scope metadata changed');
  const mapped = [
    ...capturedSources.map((source) => capture(source, ['path', 'filename', 'storageId'])),
    capture(storages, ['id', 'type', 'options']),
  ];
  const assertMetadata = () => {
    assertTransaction();
    const latest = registered();
    if (
      latest.length !== registry.length ||
      latest.some((value) => !registry.includes(value)) ||
      storages !== database.collections.get('storages') ||
      mapped.some(
        ({ collection, model, name, table, attributes }) =>
          collection.db !== database ||
          database.collections.get(name) !== collection ||
          collection.name !== name ||
          collection.model !== model ||
          database.modelCollection.get(model) !== collection ||
          generator.quoteTable(model.getTableName()) !== table ||
          attributes.some(
            ({ name, attribute, field, type, nativeType: expectedType }) =>
              model.rawAttributes[name] !== attribute ||
              attribute.field !== field ||
              String(attribute.type) !== type ||
              nativeType(attribute) !== expectedType,
          ),
      )
    )
      throw new TypeError('Removal reference scope metadata changed');
  };
  type Physical = {
    oid: string;
    schema: string;
    tableName: string;
    columns: string[];
    types: Record<string, string>;
    valid: boolean;
  };
  const physical = async (entry: (typeof mapped)[number]): Promise<Physical> => {
    assertMetadata();
    const [rows] = await database.sequelize.query(
      `SELECT c.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS "tableName",
        ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
        (SELECT jsonb_object_agg(a.attname, tn.nspname::text || '.' || t.typname::text)
          FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
          JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS types,
        (c.relkind='r' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid)) AS valid
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.oid=pg_catalog.to_regclass($table)`,
      { transaction, bind: { table: entry.table } },
    );
    assertMetadata();
    const actual = (rows as Physical[])[0];
    if (
      !actual?.valid ||
      actual.schema.includes('"') ||
      actual.tableName.includes('"') ||
      entry.attributes.some(
        ({ field, nativeType: expectedType }) =>
          !actual.columns.includes(field) || actual.types[field] !== `pg_catalog.${expectedType}`,
      )
    )
      throw new TypeError('Removal reference scope has unsupported physical tables');
    return actual;
  };
  const [settings] = await database.sequelize.query(
    `SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readonly`,
    { transaction },
  );
  assertMetadata();
  if (
    (settings as { isolation: string; readonly: string }[])[0]?.isolation !== 'serializable' ||
    (settings as { isolation: string; readonly: string }[])[0]?.readonly !== 'off'
  )
    throw new TypeError('Removal reference scope requires its active serializable transaction');
  const initial: Physical[] = [];
  for (const entry of mapped) initial.push(await physical(entry));
  if (new Set(initial.map(({ oid }) => oid)).size !== mapped.length)
    throw new TypeError('Removal reference scope has unsupported physical tables');
  const lockedTables = initial
    .map(({ schema, tableName }) => `${generator.quoteIdentifier(schema)}.${generator.quoteIdentifier(tableName)}`)
    .sort();
  await database.sequelize.query(`LOCK TABLE ${lockedTables.join(', ')} IN SHARE MODE`, { transaction });
  const assertCurrent = async () => {
    assertMetadata();
    for (let index = 0; index < mapped.length; index++) {
      if (!isDeepStrictEqual(await physical(mapped[index]), initial[index]))
        throw new TypeError('Removal reference scope physical identity changed');
    }
    assertMetadata();
  };
  await assertCurrent();
  const observed = mapped.map((entry, index) =>
    Object.freeze({
      collectionName: entry.name,
      oid: initial[index].oid,
      schema: initial[index].schema,
      tableName: initial[index].tableName,
      fields: Object.freeze(Object.fromEntries(entry.attributes.map(({ name, field }) => [name, field]))),
    }),
  );
  const lockedSources = Object.freeze(observed.slice(0, -1));
  const lockedStorage = observed.at(-1)!;
  return Object.freeze({
    sources: lockedSources,
    storage: lockedStorage,
    assertCurrent,
    observeLocalObject(object: LocalAttachmentRemovalObject) {
      return observeMappedLocalRemovalReferences(
        database,
        lockedSources,
        lockedStorage,
        transaction,
        assertCurrent,
        object,
      );
    },
  });
}
