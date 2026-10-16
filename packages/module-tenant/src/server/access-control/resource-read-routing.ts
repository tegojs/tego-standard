import type { Collection, Database } from '@tego/server';

import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { invalid, plain } from './write-support';

type ResourceReadAction = 'list' | 'get' | 'count' | 'sum';

export interface AccessResourceReadRoute {
  readonly identity: Readonly<AccessCollectionIdentity>;
  readonly actionName: ResourceReadAction;
  readonly assertCurrent: () => void;
}

/** Parsed action descriptors only. Concrete source-record routes require a separate association adapter. */
export function resolveResourceReadRoute(
  db: Database,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  action: unknown,
): AccessResourceReadRoute {
  if (
    !plain(action) ||
    Reflect.ownKeys(action).some(
      (key) =>
        typeof key !== 'string' ||
        !['resourceName', 'sourceId', 'actionName'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(action, key)!, 'value'),
    )
  )
    invalid('Unsupported resource read descriptor');
  const resourceName = Object.getOwnPropertyDescriptor(action, 'resourceName')?.value;
  const actionName = Object.getOwnPropertyDescriptor(action, 'actionName')?.value;
  const sourceId = Object.getOwnPropertyDescriptor(action, 'sourceId')?.value;
  if (
    typeof resourceName !== 'string' ||
    resourceName.length > 511 ||
    typeof actionName !== 'string' ||
    !['list', 'get', 'count', 'sum'].includes(actionName)
  )
    invalid('Unsupported resource read action or name');
  const parts = resourceName.split('.');
  if (
    parts.length > 2 ||
    parts.some(
      (part) =>
        part.length > 255 ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ||
        ['_', '__proto__', 'constructor', 'prototype'].includes(part),
    ) ||
    (parts.length === 1 ? sourceId !== undefined : sourceId !== '_' || !['list', 'get'].includes(actionName))
  )
    invalid('Only root reads and direct association placeholder get/list are supported');
  const source = db.collections.get(parts[0]);
  if (!source || source.db !== db || source.name !== parts[0] || source.model.sequelize !== db.sequelize)
    invalid('Resource read source collection is unavailable');
  const sourceModel = source.model;
  let target = source;
  let assertRelation = () => {};
  if (parts.length === 2) {
    const name = parts[1];
    const field = source.getField(name);
    const relation = Object.hasOwn(sourceModel.associations, name) && sourceModel.associations[name];
    const relatedTarget = relation && db.modelCollection.get(relation.target);
    if (
      !field ||
      !relation ||
      !relatedTarget ||
      relatedTarget.db !== db ||
      !['BelongsTo', 'HasOne', 'HasMany', 'BelongsToMany'].includes(relation.associationType) ||
      relation.source !== sourceModel ||
      relatedTarget.model !== relation.target ||
      field.target !== relatedTarget.name ||
      db.collections.get(relatedTarget.name) !== relatedTarget
    )
      invalid('Resource read association target is unavailable');
    const relationType = relation.associationType;
    const targetName = relatedTarget.name;
    assertRelation = () => {
      if (
        source.getField(name) !== field ||
        field.target !== targetName ||
        sourceModel.associations[name] !== relation ||
        relation.associationType !== relationType ||
        relation.source !== sourceModel ||
        relation.target !== relatedTarget.model
      )
        invalid('Resource read association changed during query');
    };
    // Core /_/ reads the target repository directly, including targets without an existing link.
    target = relatedTarget;
  }
  const model = target.model;
  const targetName = target.name;
  const resolved = resolveIdentity(target);
  if (!resolved || resolved.collectionName !== targetName) invalid('Resource read target identity is unavailable');
  const identity = Object.freeze({ ...resolved });
  const key = accessCollectionKey(identity);
  const assertCurrent = () => {
    const current = resolveIdentity(target);
    if (
      db.collections.get(parts[0]) !== source ||
      source.model !== sourceModel ||
      db.modelCollection.get(sourceModel) !== source ||
      db.collections.get(targetName) !== target ||
      target.model !== model ||
      model.sequelize !== db.sequelize ||
      db.modelCollection.get(model) !== target ||
      !current ||
      current.collectionName !== targetName ||
      accessCollectionKey(current) !== key
    )
      invalid('Resource read collection or identity changed during query');
    assertRelation();
  };
  assertCurrent();
  return Object.freeze({ identity, actionName: actionName as ResourceReadAction, assertCurrent });
}
