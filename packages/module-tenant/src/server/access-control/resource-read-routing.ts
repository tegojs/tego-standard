import type { Collection, Database } from '@tego/server';

import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { invalid, plain } from './write-support';

type ResourceReadAction = 'list' | 'get' | 'count' | 'sum';

interface ResourceReadRouteBase {
  /** Authorization root: the target for direct reads, or the source for concrete relationships. */
  readonly identity: Readonly<AccessCollectionIdentity>;
  readonly assertCurrent: () => void;
}

export type AccessResourceReadRoute = ResourceReadRouteBase &
  (
    | { readonly kind: 'direct'; readonly actionName: ResourceReadAction }
    | {
        readonly kind: 'association';
        readonly actionName: 'list' | 'get';
        readonly association: Readonly<{ association: string; sourceKey: string | number }>;
      }
  );

/** Parsed descriptors only; concrete sources are dispatched to the dedicated association adapters. */
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
    (parts.length === 1
      ? sourceId !== undefined
      : !['list', 'get'].includes(actionName) ||
        !(
          (typeof sourceId === 'string' && sourceId.length > 0 && sourceId.length <= 512) ||
          (typeof sourceId === 'number' && Number.isSafeInteger(sourceId))
        ))
  )
    invalid('Only root reads and bounded association get/list are supported');
  const concrete = parts.length === 2 && sourceId !== '_';
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
    if (
      concrete &&
      relationType !== 'HasMany' &&
      !(actionName === 'get' && ['HasOne', 'BelongsTo'].includes(relationType))
    )
      invalid('Concrete reads for this association type or action are not supported');
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
  const resolvedSource = concrete ? resolveIdentity(source) : undefined;
  if (
    concrete &&
    (!resolvedSource ||
      resolvedSource.collectionName !== source.name ||
      resolvedSource.dataSourceKey !== identity.dataSourceKey)
  )
    invalid('Resource read source identity is unavailable');
  const sourceIdentity = resolvedSource && Object.freeze({ ...resolvedSource });
  const sourceKey = sourceIdentity && accessCollectionKey(sourceIdentity);
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
    if (sourceIdentity) {
      const currentSource = resolveIdentity(source);
      if (
        !currentSource ||
        currentSource.collectionName !== sourceIdentity.collectionName ||
        accessCollectionKey(currentSource) !== sourceKey
      )
        invalid('Resource read source identity changed during query');
    }
    assertRelation();
  };
  assertCurrent();
  return concrete
    ? Object.freeze({
        kind: 'association',
        identity: sourceIdentity!,
        actionName: actionName as 'list' | 'get',
        association: Object.freeze({ association: parts[1], sourceKey: sourceId as string | number }),
        assertCurrent,
      })
    : Object.freeze({ kind: 'direct', identity, actionName: actionName as ResourceReadAction, assertCurrent });
}
