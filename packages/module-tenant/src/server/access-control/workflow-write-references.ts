import type { Collection, Database } from '@tego/server';

import { MAX_REFERENCE_UPDATES } from './belongs-to';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessCreationReference } from './creation';
import { assertCreationKeyArray, type AccessCreationLink } from './creation-links';
import { accessMetadataGuard } from './metadata-snapshot';
import { cloneDeep, invalid, normalizeKeys, plain } from './write-support';

/** Capture existing targets and pure join identities before any policy wait; never edits a target. */
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
  for (const name of names) {
    const original = Object.getOwnPropertyDescriptor(input, name)!.value;
    if (Array.isArray(original)) assertCreationKeyArray(original);
  }
  const source = cloneDeep(resolveIdentity(collection));
  const checks: Array<() => void> = [];
  const targets: AccessCollectionIdentity[] = [];
  const captureIdentity = (target: Collection) => {
    const identity = target && cloneDeep(resolveIdentity(target));
    if (
      !target ||
      target.db !== db ||
      !identity ||
      identity.collectionName !== target.name ||
      !source ||
      identity.dataSourceKey !== source.dataSourceKey
    )
      invalid('Workflow reference target identity is unavailable');
    const stableKey = accessCollectionKey(identity);
    targets.push(identity);
    checks.push(() => {
      const current = resolveIdentity(target);
      if (!current || current.collectionName !== target.name || accessCollectionKey(current) !== stableKey)
        invalid('Workflow reference identity changed');
    });
    return identity;
  };
  const items: AccessCreationReference[] = [];
  const links: AccessCreationLink[] = [];
  for (const name of names) {
    const relation = collection.model.associations[name];
    const field = collection.getField(name);
    if (
      !['BelongsTo', 'BelongsToMany'].includes(relation.associationType) ||
      !field ||
      field.options.interface === 'attachment'
    )
      invalid('Workflow relationship or attachment values require their own adapter');
    const target = db.modelCollection.get(relation.target);
    const identity = captureIdentity(target);
    if (field.target !== target.name) invalid('Workflow reference target identity is unavailable');
    const key = values[name];
    if (relation.associationType === 'BelongsTo') {
      if (key !== null && typeof key !== 'string' && typeof key !== 'number')
        invalid('Nested workflow reference values require their own adapter');
      items.push({ association: name, target: identity, key: key === null ? null : normalizeKeys([key], target)[0] });
    } else {
      assertCreationKeyArray(key);
      const throughModel = (relation as unknown as { through?: { model?: Collection['model'] } }).through?.model;
      const through = throughModel && db.modelCollection.get(throughModel);
      links.push({
        association: name,
        target: identity,
        through: captureIdentity(through),
        keys: key.length ? normalizeKeys(key, target) : [],
      });
    }
    const kind = field.options.interface;
    checks.push(() => {
      if (collection.getField(name) !== field || field.target !== target.name || field.options.interface !== kind)
        invalid('Workflow reference identity or field metadata changed');
    });
    delete values[name];
  }
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
    links,
    targets: [...new Map(targets.map((identity) => [accessCollectionKey(identity), identity])).values()],
    assertCurrent,
  };
}
