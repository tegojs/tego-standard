import { isDeepStrictEqual } from 'node:util';
import type { Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessQueryService } from './query';
import { cloneDeep, invalid } from './write-support';

/** Capture the registered relation, never infer a foreign key from a client-supplied path. */
export function resolveBelongsTo(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  ctx: object,
  sourceIdentity: AccessCollectionIdentity,
  targetIdentity: AccessCollectionIdentity,
  name: string,
  writing = false,
) {
  sourceIdentity = { ...sourceIdentity };
  targetIdentity = { ...targetIdentity };
  if (sourceIdentity.dataSourceKey !== targetIdentity.dataSourceKey)
    invalid('Cross-data-source references are unsupported');
  const sourceConfig = prepared.configuration(ctx, sourceIdentity);
  const targetConfig = prepared.configuration(ctx, targetIdentity);
  if (!sourceConfig || !targetConfig) invalid('Both relation collections must have prepared access configurations');
  const source = db.getCollection(sourceIdentity.collectionName);
  const target = db.getCollection(targetIdentity.collectionName);
  if (!source || !target) invalid('Association collection is unavailable');
  const sourceModel = source.model;
  const targetModel = target.model;
  const association = sourceModel.associations[name] as (typeof sourceModel.associations)[string] & {
    foreignKey?: string;
    targetKey?: string;
    scope?: Record<string, unknown>;
  };
  if (
    !association ||
    association.associationType !== 'BelongsTo' ||
    association.source !== sourceModel ||
    association.target !== targetModel ||
    sourceModel.sequelize !== db.sequelize ||
    targetModel.sequelize !== db.sequelize ||
    sourceModel.primaryKeyAttributes.length !== 1 ||
    targetModel.primaryKeyAttributes.length !== 1 ||
    association.targetKey !== targetModel.primaryKeyAttribute
  )
    invalid('Only registered same-database BelongsTo references to a single primary key are supported');
  const foreignKey = association.foreignKey!;
  const attribute = sourceModel.rawAttributes[foreignKey];
  if (!attribute || foreignKey === 'tenantId' || sourceModel.primaryKeyAttributes.includes(foreignKey))
    invalid('Unsupported source foreign key');
  const scope = cloneDeep(association.scope);
  const targetKey = association.targetKey;
  const current = () => {
    if (
      prepared.configuration(ctx, sourceIdentity) !== sourceConfig ||
      prepared.configuration(ctx, targetIdentity) !== targetConfig ||
      !queries.isCurrentCollection(sourceIdentity, source, sourceModel) ||
      !queries.isCurrentCollection(targetIdentity, target, targetModel) ||
      sourceModel.associations[name] !== association ||
      association.source !== sourceModel ||
      association.target !== targetModel ||
      association.associationType !== 'BelongsTo' ||
      association.foreignKey !== foreignKey ||
      association.targetKey !== targetKey ||
      sourceModel.rawAttributes[foreignKey] !== attribute ||
      !isDeepStrictEqual(association.scope, scope)
    )
      invalid('Association identity changed during authorization');
    if (writing) {
      // One FK must not silently alter a second relation or act as somebody else's referenced key.
      for (const collection of db.collections.values())
        for (const entry of Object.values(collection.model.associations)) {
          const other = entry as typeof entry & {
            foreignKey?: string;
            otherKey?: string;
            sourceKey?: string;
            targetKey?: string;
            through?: { model?: typeof sourceModel };
          };
          if (other === association) continue;
          if (
            (other.source === sourceModel &&
              (other.associationType === 'BelongsTo'
                ? other.foreignKey === foreignKey
                : other.sourceKey === foreignKey)) ||
            (other.target === sourceModel &&
              (other.associationType === 'BelongsTo'
                ? other.targetKey === foreignKey
                : other.associationType === 'BelongsToMany'
                  ? other.targetKey === foreignKey
                  : other.foreignKey === foreignKey &&
                    (other.source !== targetModel || other.sourceKey !== targetKey))) ||
            (other.through?.model === sourceModel && [other.foreignKey, other.otherKey].includes(foreignKey))
          )
            invalid('Foreign key also changes an unsupported relationship');
        }
    }
  };
  current();
  return {
    source,
    target,
    sourceModel,
    targetModel,
    sourceConfig,
    targetConfig,
    association,
    foreignKey,
    scope,
    current,
  };
}
