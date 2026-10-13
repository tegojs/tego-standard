import { isDeepStrictEqual } from 'node:util';
import { Op, Transaction, type Collection, type Database, type Model, type WhereOptions } from '@tego/server';

import { AccessMutationError } from './mutation-errors';
import type { AccessCondition, AccessConfig } from './types';

export function invalid(message: string): never {
  throw new AccessMutationError('INVALID_ACCESS_MUTATION', message, 400);
}

export function unavailable(): never {
  throw new AccessMutationError('ACCESS_RECORD_UNAVAILABLE', 'Record is unavailable for this mutation');
}

function relational(condition: AccessCondition): boolean {
  switch (condition.type) {
    case 'exists':
      return true;
    case 'tenantRelation':
      return condition.relation !== 'same';
    case 'all':
    case 'any':
      return condition.children.some(relational);
    case 'not':
      return relational(condition.child);
    case 'compare':
      return [condition.left, condition.right].some(
        (value) => value.type === 'context' && ['tenant.ancestorIds', 'tenant.descendantIds'].includes(value.path),
      );
    case 'isNull':
      return (
        condition.operand.type === 'context' &&
        ['tenant.ancestorIds', 'tenant.descendantIds'].includes(condition.operand.path)
      );
    default:
      return false;
  }
}

export function plain(value: unknown): value is Record<PropertyKey, unknown> {
  return !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function internalQuery<T extends object>(options: T) {
  return { ...options, hooks: false, useMaster: true };
}

/** Preserve Sequelize operator symbols and expression prototypes without adding a package dependency. */
export function cloneDeep<T>(input: T): T {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (value: unknown, depth = 0): unknown => {
    if (++nodes > 10000 || depth > 32) invalid('Mutation input exceeds size or depth limit');
    if (typeof value === 'function') invalid('Mutation inputs cannot contain functions');
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (seen.has(value)) invalid('Mutation inputs cannot contain cycles');
    seen.add(value);
    const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Mutation inputs cannot contain accessors');
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: descriptor.enumerable,
        writable: true,
        configurable: true,
      });
    }
    seen.delete(value);
    return result;
  };
  return copy(input) as T;
}

/** Unknown Sequelize expressions can read other tables. Never infer root-only safety from SQL text. */
function rootPredicate(value: unknown, collection: Collection, fieldValue = false): boolean {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value) || value instanceof Date)
    return fieldValue;
  if (Array.isArray(value)) return value.every((item) => rootPredicate(item, collection, fieldValue));
  if (!plain(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    if ([Op.and, Op.or, Op.not].includes(key as symbol)) return rootPredicate(value[key], collection, fieldValue);
    if (fieldValue) return typeof key === 'symbol' && rootPredicate(value[key], collection, true);
    return (
      typeof key === 'string' &&
      Object.hasOwn(collection.model.rawAttributes, key) &&
      rootPredicate(value[key], collection, true)
    );
  });
}

export function requiresSerializable(
  config: AccessConfig,
  request: { where?: WhereOptions },
  collection: Collection,
): boolean {
  return (
    config.rules.some(
      (rule) =>
        rule.enabled && rule.category === 'ownership' && (relational(rule.subject) || relational(rule.condition)),
    ) ||
    (request.where !== undefined && !rootPredicate(request.where, collection))
  );
}

export function normalizeKeys(keys: unknown, collection: Collection): string[] {
  if (!Array.isArray(keys) || !keys.length || keys.length > 1000)
    invalid('Select between 1 and 1000 explicit record keys');
  const model = collection.model;
  if (model.primaryKeyAttributes.length !== 1) invalid('Existing mutations require a single primary key');
  const type = (model.rawAttributes[model.primaryKeyAttribute].type as { key?: string }).key;
  if (!type) invalid('Mutation key type is unavailable');
  const integer = ['INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT'].includes(type);
  if (!integer && !['STRING', 'TEXT', 'UUID'].includes(type)) invalid('Unsupported mutation key type');
  return [
    ...new Set(
      keys.map((key) => {
        if (
          (typeof key !== 'string' && typeof key !== 'number') ||
          (typeof key === 'number' && !Number.isSafeInteger(key))
        )
          invalid('Invalid record key');
        const text = String(key);
        if (!text || text.length > 255) invalid('Invalid record key');
        if (integer) {
          if (!/^-?\d+$/.test(text)) invalid('Invalid integer record key');
          return BigInt(text).toString();
        }
        if (typeof key !== 'string') invalid('String record keys must be strings');
        return type === 'UUID' ? text.toLowerCase() : text;
      }),
    ),
  ];
}

export async function validateWriteTransaction(
  db: Database,
  transaction: Transaction | undefined,
  serializable: boolean,
) {
  const state = transaction as Transaction & {
    sequelize?: Database['sequelize'];
    finished?: string;
    options?: { readOnly?: boolean; isolationLevel?: string; type?: string };
    parent?: Transaction;
  };
  if (
    !(transaction instanceof Transaction) ||
    state.sequelize !== db.sequelize ||
    state.finished ||
    state.options?.readOnly ||
    state.parent
  )
    invalid('An active root write transaction is required');
  const dialect = db.sequelize.getDialect();
  if (dialect === 'postgres') {
    const [rows] = await db.sequelize.query(
      "SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation",
      { transaction },
    );
    const actual = (rows as Array<{ read_only: string; isolation: string }>)[0];
    if (actual.read_only !== 'off' || (serializable && actual.isolation !== 'serializable'))
      invalid('Mutation requires a writable transaction with sufficient isolation');
  } else if (dialect === 'sqlite') {
    if (serializable)
      throw new AccessMutationError('UNSUPPORTED_ACCESS_MUTATION', 'Relational writes require PostgreSQL', 400);
    if (state.options?.type !== Transaction.TYPES.IMMEDIATE && state.options?.type !== Transaction.TYPES.EXCLUSIVE)
      invalid('SQLite mutations require an immediate write transaction');
  } else throw new AccessMutationError('UNSUPPORTED_ACCESS_MUTATION', 'Mutation dialect has not been validated', 400);
}

/** Only root fields are supported until relationship write adapters validate their actual write locations. */
export function rootWriteBlockedFields(db: Database, collection: Collection, operation: 'update' | 'create') {
  const model = collection.model;
  const protectedFields = new Set(operation === 'update' ? model.primaryKeyAttributes : []);
  const protectKey = (key: string | undefined) => {
    if (key && !(operation === 'create' && model.primaryKeyAttributes.includes(key))) protectedFields.add(key);
  };
  for (const other of db.collections.values()) {
    for (const association of Object.values(other.model.associations)) {
      const relation = association as typeof association & {
        foreignKey?: string;
        sourceKey?: string;
        targetKey?: string;
        otherKey?: string;
        through?: { model?: typeof model };
      };
      if (relation.source === model) {
        if (relation.associationType === 'BelongsTo' && relation.foreignKey) protectedFields.add(relation.foreignKey);
        else protectKey(relation.sourceKey);
      }
      if (relation.target === model) {
        if (relation.associationType === 'BelongsTo') protectKey(relation.targetKey);
        else if (relation.associationType !== 'BelongsToMany' && relation.foreignKey)
          protectedFields.add(relation.foreignKey);
      }
      if (relation.through?.model === model) {
        if (relation.foreignKey) protectedFields.add(relation.foreignKey);
        if (relation.otherKey) protectedFields.add(relation.otherKey);
      }
    }
  }
  for (const [key, attribute] of Object.entries(model.rawAttributes)) {
    if (attribute.references || (attribute.type as { key?: string }).key === 'VIRTUAL') protectedFields.add(key);
  }
  return protectedFields;
}

export function validateRootValues(
  db: Database,
  values: unknown,
  collection: Collection,
  operation: 'update' | 'create',
  managedOwnership = false,
) {
  if (!plain(values) || (operation === 'update' && !Object.keys(values).length)) invalid('Supply root field values');
  const blocked = rootWriteBlockedFields(db, collection, operation);
  // Managed ownership has its own exact tenant check, even when this column is also a foreign key.
  for (const key of Reflect.ownKeys(values)) {
    if (
      typeof key !== 'string' ||
      !Object.hasOwn(collection.model.rawAttributes, key) ||
      (blocked.has(key) && !(managedOwnership && key === 'tenantId'))
    )
      invalid('Association fields, reference keys and protected keys require their own write adapters');
  }
}

/** Hooks may change values absent from the supplied patch. Keep all other relationship keys intact. */
export function snapshotProtectedValues(
  db: Database,
  collection: Collection,
  records: readonly Model[],
  allowed: readonly string[] = [],
) {
  const protectedFields = () =>
    [...rootWriteBlockedFields(db, collection, 'update')]
      .filter(
        (key) =>
          !allowed.includes(key) &&
          collection.model.rawAttributes[key] &&
          (collection.model.rawAttributes[key].type as { key?: string }).key !== 'VIRTUAL',
      )
      .sort();
  const fields = protectedFields();
  const primary = collection.model.primaryKeyAttribute;
  const before = new Map(
    records.map((record) => [
      String(record.getDataValue(primary)),
      cloneDeep(fields.map((key) => record.getDataValue(key))),
    ]),
  );
  return {
    fields,
    verify(after: readonly Model[]) {
      if (!isDeepStrictEqual(fields, protectedFields()))
        invalid('Protected relationship metadata changed during write');
      for (const record of after) {
        const expected = before.get(String(record.getDataValue(primary)));
        if (
          !expected ||
          !isDeepStrictEqual(
            expected,
            fields.map((key) => record.getDataValue(key)),
          )
        )
          invalid('Writer changed another protected relationship key');
      }
    },
  };
}
