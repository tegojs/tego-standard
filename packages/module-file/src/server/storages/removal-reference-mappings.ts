import type { Collection, Database } from '@tego/server';

export interface AttachmentRemovalReferenceMappings {
  readonly sources: readonly Collection[];
  readonly storages: Collection;
}

/** Capture both trusted instances, not just whichever subset the observer happened to map. */
export function captureRemovalReferenceMappings(
  business: Database,
  observer: Database,
  mappings: AttachmentRemovalReferenceMappings,
) {
  const invalid = (): never => {
    throw new TypeError('Removal reference mappings do not cover the business instance');
  };
  const files = (database: Database) =>
    [...database.collections.values()].filter((value) => value.options.template === 'file');
  const originals = files(business);
  const sources = [...mappings.sources];
  const storages = mappings.storages;
  if (
    !sources.length ||
    new Set(sources).size !== sources.length ||
    originals.length !== sources.length ||
    files(observer).length !== sources.length ||
    files(observer).some((value) => !sources.includes(value)) ||
    storages !== observer.collections.get('storages')
  )
    return invalid();
  const generator = observer.sequelize.getQueryInterface().queryGenerator as unknown as {
    quoteTable(table: unknown): string;
  };
  const capture = (database: Database, collection: Collection, fields: string[]) => {
    const model = collection?.model;
    if (
      !model ||
      collection.db !== database ||
      database.collections.get(collection.name) !== collection ||
      database.modelCollection.get(model) !== collection ||
      fields.some((name) => !model.rawAttributes[name])
    )
      return invalid();
    const name = collection.name;
    const attributes = fields.map((name) => ({ name, value: model.rawAttributes[name] }));
    const stamp = () =>
      JSON.stringify([
        collection.name,
        generator.quoteTable(model.getTableName()),
        fields.map((name) => [name, model.rawAttributes[name]?.field, String(model.rawAttributes[name]?.type)]),
      ]);
    const expected = stamp();
    return {
      expected,
      current: () =>
        collection.db === database &&
        collection.model === model &&
        database.collections.get(name) === collection &&
        database.modelCollection.get(model) === collection &&
        attributes.every(({ name, value }) => model.rawAttributes[name] === value) &&
        stamp() === expected,
    };
  };
  const pairs = originals.map((original) => {
    const mapped = sources.find((value) => value.name === original.name);
    if (!mapped) return invalid();
    return [
      capture(business, original, ['path', 'filename', 'storageId']),
      capture(observer, mapped, ['path', 'filename', 'storageId']),
    ];
  });
  const businessStorage = business.collections.get('storages');
  if (!businessStorage) return invalid();
  pairs.push([
    capture(business, businessStorage, ['id', 'type', 'options']),
    capture(observer, storages, ['id', 'type', 'options']),
  ]);
  if (pairs.some(([original, mapped]) => original.expected !== mapped.expected)) return invalid();
  const assertCurrent = () => {
    const latest = files(business);
    const mapped = files(observer);
    if (
      latest.length !== originals.length ||
      latest.some((value) => !originals.includes(value)) ||
      mapped.length !== sources.length ||
      mapped.some((value) => !sources.includes(value)) ||
      pairs.some((pair) => pair.some((value) => !value.current()))
    )
      throw new TypeError('Removal reference mappings changed');
  };
  assertCurrent();
  return Object.freeze({ sources: Object.freeze(sources), storages, assertCurrent });
}
