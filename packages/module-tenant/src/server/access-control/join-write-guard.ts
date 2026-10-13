import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Collection, Database, Model, Transaction } from '@tego/server';

import { invalid, normalizeKeys, plain } from './write-support';

interface JoinWrite {
  operation: 'add' | 'remove';
  sourceKey: string;
  targetKeys: readonly string[];
}

/** Verify the final bulk input after business hooks, confined to this async operation. */
export async function guardJoinWrite(
  db: Database,
  source: Collection,
  target: Collection,
  through: Collection,
  foreignKey: string,
  otherKey: string,
  transaction: Transaction,
  expected: JoinWrite,
  current: () => void,
  writer: () => Promise<unknown>,
) {
  const active = new AsyncLocalStorage<boolean>();
  const name = `tenant-access-join-${randomUUID()}`;
  let calls = 0;
  let writes = 0;
  let verifyInput: (() => void) | undefined;
  const optionsFor = (options: Record<string, unknown>, operation: JoinWrite['operation']) => {
    if (!active.getStore()) return false;
    current();
    if (
      operation !== expected.operation ||
      ++calls !== 1 ||
      options.model !== through.model ||
      options.transaction !== transaction ||
      options.individualHooks ||
      options.include ||
      options.updateOnDuplicate ||
      options.conflictAttributes ||
      options.upsertKeys ||
      options.ignoreDuplicates ||
      options.truncate ||
      options.cascade ||
      options.limit ||
      options.hooks !== true
    )
      invalid('Join hooks changed the authorized write path');
    return true;
  };
  db.sequelize.addHook('beforeBulkCreate', name, (rows: Model[], options: Record<string, unknown>) => {
    if (!optionsFor(options, 'add')) return;
    verifyInput = () => {
      if (!Array.isArray(rows) || rows.length !== expected.targetKeys.length)
        invalid('Join hooks changed the insert batch');
      const remaining = new Set(expected.targetKeys);
      const fields = options.fields;
      if (!Array.isArray(fields) || !fields.includes(foreignKey) || !fields.includes(otherKey))
        invalid('Join hooks removed an authorized insert key');
      for (const row of rows) {
        if (
          !(row instanceof through.model) ||
          normalizeKeys([row.getDataValue(foreignKey)], source)[0] !== expected.sourceKey ||
          !remaining.delete(normalizeKeys([row.getDataValue(otherKey)], target)[0]) ||
          through.model.primaryKeyAttributes.some(
            (key) => ![foreignKey, otherKey].includes(key) && row.getDataValue(key) != null,
          )
        )
          invalid('Join hooks changed authorized insert keys');
      }
    };
    verifyInput();
  });
  db.sequelize.addHook('beforeBulkDestroy', name, (options: Record<string, unknown>) => {
    if (!optionsFor(options, 'remove')) return;
    verifyInput = () => {
      const where = options.where;
      if (
        !plain(where) ||
        Reflect.ownKeys(where).length !== 2 ||
        !Object.hasOwn(where, foreignKey) ||
        !Object.hasOwn(where, otherKey)
      )
        invalid('Join hooks changed the authorized deletion predicate');
      const keys = normalizeKeys(where[otherKey], target);
      if (
        normalizeKeys([where[foreignKey]], source)[0] !== expected.sourceKey ||
        keys.length !== expected.targetKeys.length ||
        keys.some((key) => !expected.targetKeys.includes(key))
      )
        invalid('Join hooks changed authorized deletion keys');
    };
    verifyInput();
  });
  // Model hooks can issue nested single/bulk writes, including hooks:false. Check the actual query path too.
  db.sequelize.addHook('beforeQuery', name, (options: Record<string, unknown>) => {
    if (!active.getStore() || options.model !== through.model || options.type === 'SELECT') return;
    current();
    if (
      calls !== 1 ||
      ++writes !== 1 ||
      options.transaction !== transaction ||
      options.instance ||
      options.type !== (expected.operation === 'add' ? 'INSERT' : 'BULKDELETE') ||
      !verifyInput
    )
      invalid('Join hooks issued an unauthorized database write');
    verifyInput();
  });
  try {
    await active.run(true, writer);
    if (calls !== 1 || writes !== 1) invalid('Join writer bypassed the guarded bulk path');
  } finally {
    db.sequelize.removeHook('beforeBulkCreate', name);
    db.sequelize.removeHook('beforeBulkDestroy', name);
    db.sequelize.removeHook('beforeQuery', name);
    active.disable();
  }
}
