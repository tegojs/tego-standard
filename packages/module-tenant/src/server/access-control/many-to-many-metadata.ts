import { isDeepStrictEqual } from 'node:util';
import type { Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessQueryService } from './query';
import { cloneDeep, invalid } from './write-support';

/** Pure join tables only: business/owned through records need their own G write adapter. */
export function resolveManyToMany(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  ctx: object,
  sourceIdentity: AccessCollectionIdentity,
  targetIdentity: AccessCollectionIdentity,
  throughIdentity: AccessCollectionIdentity,
  name: string,
) {
  if (
    sourceIdentity.dataSourceKey !== targetIdentity.dataSourceKey ||
    sourceIdentity.dataSourceKey !== throughIdentity.dataSourceKey
  )
    invalid('Cross-data-source links are unsupported');
  const sourceConfig = prepared.configuration(ctx, sourceIdentity);
  const targetConfig = prepared.configuration(ctx, targetIdentity);
  if (!sourceConfig || !targetConfig) invalid('Both relation collections must have prepared access configurations');
  if (prepared.configuration(ctx, throughIdentity))
    invalid('Independently controlled join records require their own G adapter');
  const source = db.getCollection(sourceIdentity.collectionName);
  const target = db.getCollection(targetIdentity.collectionName);
  if (!source || !target) invalid('Association collection is unavailable');
  const sourceModel = source.model;
  const targetModel = target.model;
  const association = sourceModel.associations[name] as (typeof sourceModel.associations)[string] & {
    sourceKey?: string;
    targetKey?: string;
    foreignKey?: string;
    otherKey?: string;
    scope?: Record<string, unknown>;
    through?: { model?: typeof sourceModel; scope?: Record<string, unknown> };
  };
  const throughModel = association?.through?.model;
  if (
    !association ||
    association.associationType !== 'BelongsToMany' ||
    association.source !== sourceModel ||
    association.target !== targetModel ||
    sourceModel === targetModel ||
    sourceModel.sequelize !== db.sequelize ||
    targetModel.sequelize !== db.sequelize ||
    sourceModel.primaryKeyAttributes.length !== 1 ||
    targetModel.primaryKeyAttributes.length !== 1 ||
    association.sourceKey !== sourceModel.primaryKeyAttribute ||
    association.targetKey !== targetModel.primaryKeyAttribute ||
    !throughModel ||
    throughModel.sequelize !== db.sequelize
  )
    invalid(
      'Only registered same-database many-to-many links between distinct single-primary-key models are supported',
    );
  const through = db.getCollection(throughModel.name);
  if (!through || through.model !== throughModel || through.name !== throughIdentity.collectionName)
    invalid('Join collection is unavailable');
  const foreignKey = association.foreignKey!;
  const otherKey = association.otherKey!;
  if (!foreignKey || !otherKey || foreignKey === otherKey) invalid('Join keys are unavailable');
  const scope = cloneDeep(association.scope);
  const attributes = { ...throughModel.rawAttributes };
  const current = () => {
    if (
      prepared.configuration(ctx, sourceIdentity) !== sourceConfig ||
      prepared.configuration(ctx, targetIdentity) !== targetConfig ||
      !queries.isCurrentCollection(sourceIdentity, source, sourceModel) ||
      !queries.isCurrentCollection(targetIdentity, target, targetModel) ||
      prepared.configuration(ctx, throughIdentity) !== null ||
      !queries.isCurrentCollection(throughIdentity, through, throughModel) ||
      db.getCollection(through.name) !== through ||
      through.model !== throughModel ||
      sourceModel.associations[name] !== association ||
      association.source !== sourceModel ||
      association.target !== targetModel ||
      association.associationType !== 'BelongsToMany' ||
      association.through?.model !== throughModel ||
      association.sourceKey !== sourceModel.primaryKeyAttribute ||
      association.targetKey !== targetModel.primaryKeyAttribute ||
      association.foreignKey !== foreignKey ||
      association.otherKey !== otherKey ||
      !isDeepStrictEqual(association.scope, scope)
    )
      invalid('Association identity changed during authorization');
    const model = throughModel as typeof throughModel & { _timestampAttributes?: Record<string, string> };
    const timestamps = Object.values(model._timestampAttributes ?? {});
    if (
      association.through?.scope ||
      throughModel.options.paranoid ||
      Reflect.ownKeys(throughModel.options.defaultScope ?? {}).length ||
      !attributes[foreignKey] ||
      !attributes[otherKey] ||
      !isDeepStrictEqual(Object.keys(attributes).sort(), Object.keys(throughModel.rawAttributes).sort()) ||
      Object.entries(attributes).some(
        ([key, attr]) =>
          throughModel.rawAttributes[key] !== attr ||
          (key !== foreignKey &&
            key !== otherKey &&
            !timestamps.includes(key) &&
            !(attr.primaryKey && attr.autoIncrement)),
      )
    )
      invalid('Join tables with business fields, ownership, scopes or soft deletion require a separate write adapter');
    for (const collection of db.collections.values()) {
      for (const entry of Object.values(collection.model.associations)) {
        const other = entry as typeof association;
        if (other === association || other.associationType !== 'BelongsToMany' || other.through?.model !== throughModel)
          continue;
        const forward =
          other.source === sourceModel &&
          other.target === targetModel &&
          other.sourceKey === association.sourceKey &&
          other.targetKey === association.targetKey &&
          other.foreignKey === foreignKey &&
          other.otherKey === otherKey;
        const reverse =
          other.source === targetModel &&
          other.target === sourceModel &&
          other.sourceKey === association.targetKey &&
          other.targetKey === association.sourceKey &&
          other.foreignKey === otherKey &&
          other.otherKey === foreignKey;
        if (!forward && !reverse) invalid('Join keys also change an unsupported relationship');
      }
    }
  };
  current();
  return {
    source,
    target,
    through,
    sourceModel,
    targetModel,
    throughModel,
    sourceConfig,
    foreignKey,
    otherKey,
    scope,
    current,
  };
}
