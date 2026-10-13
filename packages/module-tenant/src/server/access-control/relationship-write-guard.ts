import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Collection, Database, Model, Transaction } from '@tego/server';

import { invalid, normalizeKeys } from './write-support';

/** Confine each repository write to its one authorized instance, after all model hooks. */
export async function guardRelationshipUpdate(
  db: Database,
  collections: readonly Collection[],
  expected: Collection,
  key: string,
  transaction: Transaction,
  current: () => void,
  writer: () => Promise<unknown>,
) {
  const active = new AsyncLocalStorage<boolean>();
  const name = `tenant-access-child-${randomUUID()}`;
  const models = new Set(collections.map((collection) => collection.model));
  const model = expected.model;
  const primary = model.primaryKeyAttribute;
  let writes = 0;
  db.sequelize.addHook('beforeQuery', name, (options: Record<string, unknown>) => {
    if (!active.getStore() || !models.has(options.model as typeof model) || options.type === 'SELECT') return;
    current();
    const instance = options.instance as Model | undefined;
    if (
      ++writes !== 1 ||
      options.model !== model ||
      options.type !== 'UPDATE' ||
      options.transaction !== transaction ||
      !(instance instanceof model) ||
      instance.isNewRecord ||
      normalizeKeys([instance.getDataValue(primary)], expected)[0] !== key
    )
      invalid('Relationship hooks changed the authorized database write');
  });
  try {
    await active.run(true, writer);
    if (writes !== 1) invalid('Relationship writer bypassed the guarded instance update');
  } finally {
    db.sequelize.removeHook('beforeQuery', name);
    active.disable();
  }
}
