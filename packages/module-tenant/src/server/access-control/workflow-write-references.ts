import type { Collection, Database } from '@tego/server';

import { MAX_REFERENCE_UPDATES } from './belongs-to';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessCreationReference } from './creation';
import { accessMetadataGuard } from './metadata-snapshot';
import { cloneDeep, invalid, normalizeKeys, plain } from './write-support';

/** Capture existing single-value targets before any policy wait; never authorizes or edits a target. */
export function captureWorkflowWriteReferences(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  collection: Collection,
  input: unknown,
) {
  if (!plain(input)) invalid('Workflow writes require named field values');
  const values = cloneDeep(input);
  const names = Object.keys(values).filter((name) => Object.hasOwn(collection.model.associations, name));
  if (names.length > MAX_REFERENCE_UPDATES) invalid('Workflow writes support at most 20 references');
  const source = resolveIdentity(collection);
  const checks: Array<() => void> = [];
  const items: AccessCreationReference[] = names.map((name) => {
    const relation = collection.model.associations[name];
    const field = collection.getField(name);
    if (relation.associationType !== 'BelongsTo' || !field || field.options.interface === 'attachment')
      invalid('Workflow relationship or attachment values require their own adapter');
    const target = db.modelCollection.get(relation.target);
    const identity = target && cloneDeep(resolveIdentity(target));
    if (
      !target ||
      target.db !== db ||
      !identity ||
      identity.collectionName !== target.name ||
      !source ||
      identity.dataSourceKey !== source.dataSourceKey ||
      field.target !== target.name
    )
      invalid('Workflow reference target identity is unavailable');
    const key = values[name];
    if (key !== null && typeof key !== 'string' && typeof key !== 'number')
      invalid('Nested workflow reference values require their own adapter');
    const normalized = key === null ? null : normalizeKeys([key], target)[0];
    const stableKey = accessCollectionKey(identity);
    const kind = field.options.interface;
    checks.push(() => {
      const current = resolveIdentity(target);
      if (
        !current ||
        current.collectionName !== target.name ||
        accessCollectionKey(current) !== stableKey ||
        collection.getField(name) !== field ||
        field.target !== target.name ||
        field.options.interface !== kind
      )
        invalid('Workflow reference identity or field metadata changed');
    });
    delete values[name];
    return { association: name, target: identity, key: normalized };
  });
  const metadata = accessMetadataGuard(
    db,
    [],
    names.map((name) => ({ model: collection.model, path: [name] })),
  );
  const assertCurrent = () => {
    metadata();
    for (const check of checks) check();
  };
  assertCurrent();
  return {
    values,
    items,
    targets: [...new Map(items.map((item) => [accessCollectionKey(item.target), item.target])).values()],
    assertCurrent,
  };
}
