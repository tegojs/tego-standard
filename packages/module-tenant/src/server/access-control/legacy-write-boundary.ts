import type { Collection, Database } from '@tego/server';

import { cloneDeep, invalid, plain } from './write-support';

/** Reject unadapted references by registered write locations, without executing a mixed write. */
export function assertLegacyWriteBoundary(
  db: Database,
  source: Collection,
  params: object,
  protectedCollection: (collection: Collection) => boolean,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(params, 'values');
  if (descriptor && !Object.hasOwn(descriptor, 'value')) invalid('Legacy write values cannot contain accessors');
  const check = (collection: Collection | undefined) => {
    if (!collection || collection.db !== db || db.getCollection(collection.name) !== collection)
      invalid('Legacy write collection changed');
    if (protectedCollection(collection))
      invalid('Legacy writes involving selected access collections require a dedicated adapter');
  };
  let nodes = 0;
  const inspect = (collection: Collection, values: unknown, depth: number) => {
    if (++nodes > 1000 || depth > 8) invalid('Legacy write exceeds the supported relationship limit');
    check(collection);
    if (Array.isArray(values)) {
      for (const value of values) inspect(collection, value, depth + 1);
      return;
    }
    if (!plain(values)) return;
    for (const [name, relation] of Object.entries(collection.model.associations)) {
      const association = relation as typeof relation & {
        foreignKey?: string;
        through?: { model?: Collection['model'] };
      };
      const nested = Object.hasOwn(values, name);
      const foreignKey = association.associationType === 'BelongsTo' && association.foreignKey;
      if (!nested && !(foreignKey && Object.hasOwn(values, foreignKey))) continue;
      const target = db.modelCollection.get(association.target);
      check(target);
      if (association.through?.model) check(db.modelCollection.get(association.through.model));
      if (nested) inspect(target, values[name], depth + 1);
    }
    // A target-side FK or a pure join-table row may have no reciprocal association field.
    for (const owner of db.collections.values())
      for (const relation of Object.values(owner.model.associations)) {
        const association = relation as typeof relation & {
          foreignKey?: string;
          otherKey?: string;
          through?: { model?: Collection['model'] };
        };
        if (
          association.target === collection.model &&
          ['HasMany', 'HasOne'].includes(association.associationType) &&
          association.foreignKey &&
          Object.hasOwn(values, association.foreignKey)
        )
          check(owner);
        if (
          association.through?.model === collection.model &&
          [association.foreignKey, association.otherKey].some((key) => key && Object.hasOwn(values, key))
        ) {
          check(owner);
          check(db.modelCollection.get(association.target));
        }
      }
  };
  inspect(source, cloneDeep(descriptor?.value), 0);
}
