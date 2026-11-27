import type { Collection, Database } from '@tego/server';

import { cloneDeep, invalid, plain } from './write-support';

/** Chart field vectors name one registered association; filters use the existing repository grammar. */
export function assertLegacyChartReadBoundary(
  db: Database,
  source: Collection,
  params: object,
  protectedCollection: (collection: Collection) => boolean,
  context: object,
): void {
  const captured = cloneDeep(params) as Record<string, unknown>;
  // The original chart pipeline also accepts the query fields directly without a values envelope.
  const values = captured.values === undefined ? captured : captured.values;
  if (!plain(values)) invalid('Legacy chart values are unavailable');
  const appends = new Set<string>();
  for (const key of ['measures', 'dimensions', 'orders']) {
    const entries = values[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!plain(entry) || !Array.isArray(entry.field) || entry.field.length < 2) continue;
      if (typeof entry.field[0] !== 'string') invalid('Legacy chart requires registered association names');
      appends.add(entry.field[0]);
    }
  }
  assertLegacyReadBoundary(db, source, { appends: [...appends], filter: values.filter }, protectedCollection, context);
}

/** Inspect the existing repository plan; this neither authorizes nor executes a mixed read. */
export function assertLegacyReadBoundary(
  db: Database,
  source: Collection,
  params: object,
  protectedCollection: (collection: Collection) => boolean,
  context: object,
): void {
  let nodes = 0;
  const check = (collection: Collection) => {
    if (collection.db !== db || db.getCollection(collection.name) !== collection)
      invalid('Legacy read collection changed');
    if (protectedCollection(collection))
      invalid('Legacy reads of selected access collections require a dedicated adapter');
  };
  const inspect = (collection: Collection, input: object, depth: number) => {
    if (++nodes > 1000 || depth > 8) invalid('Legacy read plan exceeds the supported relationship limit');
    check(collection);
    // Keep the legacy parser's actual filter/field/append/sort grammar and its mutations private.
    const options = Object.fromEntries(
      ['filter', 'fields', 'appends', 'except', 'sort', 'include']
        .map((key) => [key, Object.getOwnPropertyDescriptor(input, key)])
        .filter((entry): entry is [string, PropertyDescriptor] => entry[1] !== undefined)
        .map(([key, descriptor]) => {
          if (!Object.hasOwn(descriptor, 'value')) invalid('Legacy read options cannot contain accessors');
          return [key, cloneDeep(descriptor.value)];
        }),
    );
    const query = collection.repository.buildQueryOptions({ ...options, context });
    const includes = (parent: Collection, entries: unknown, level: number) => {
      if (entries === undefined) return;
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        if (++nodes > 1000 || level > 8) invalid('Legacy read plan exceeds the supported relationship limit');
        const name = typeof entry === 'string' ? entry : plain(entry) ? entry.association : undefined;
        if (typeof name !== 'string') invalid('Legacy read plan requires registered association names');
        const association = Object.hasOwn(parent.model.associations, name) && parent.model.associations[name];
        const target = association && db.modelCollection.get(association.target);
        if (!target) invalid('Legacy read association is unavailable');
        check(target);
        const through = (association as typeof association & { through?: { model?: Collection['model'] } }).through
          ?.model;
        if (through) {
          const collection = db.modelCollection.get(through);
          if (!collection) invalid('Legacy read through collection is unavailable');
          check(collection);
        }
        if (plain(entry)) {
          includes(target, entry.include, level + 1);
          if (plain(entry.options)) inspect(target, entry.options, level + 1);
        }
      }
    };
    includes(collection, query.include, depth + 1);
    for (const order of query.order ?? [])
      if (Array.isArray(order))
        for (const part of order)
          if (plain(part) && part.model) {
            const target = db.modelCollection.get(part.model as Collection['model']);
            if (!target) invalid('Legacy read sort collection is unavailable');
            check(target);
          }
  };
  inspect(source, params, 0);
}
