import type { Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessQueryService } from './query';
import { invalid } from './write-support';

/** HasMany and HasOne store the relationship on the target, which is actually edited. */
export function resolveTargetForeignKey(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  ctx: object,
  sourceIdentity: AccessCollectionIdentity,
  targetIdentity: AccessCollectionIdentity,
  name: string,
  associationType: 'HasMany' | 'HasOne',
) {
  if (sourceIdentity.dataSourceKey !== targetIdentity.dataSourceKey)
    invalid('Cross-data-source child mutations are unsupported');
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
    sourceKey?: string;
    scope?: Record<string, unknown>;
  };
  if (
    !association ||
    association.associationType !== associationType ||
    association.source !== sourceModel ||
    association.target !== targetModel ||
    sourceModel === targetModel ||
    sourceModel.sequelize !== db.sequelize ||
    targetModel.sequelize !== db.sequelize ||
    sourceModel.primaryKeyAttributes.length !== 1 ||
    targetModel.primaryKeyAttributes.length !== 1 ||
    association.sourceKey !== sourceModel.primaryKeyAttribute
  )
    invalid(
      'Only registered same-database target foreign keys between distinct single-primary-key models are supported',
    );
  const foreignKey = association.foreignKey!;
  const attribute = targetModel.rawAttributes[foreignKey];
  if (!attribute || foreignKey === 'tenantId' || targetModel.primaryKeyAttributes.includes(foreignKey))
    invalid('Unsupported target foreign key');
  const sourceKey = association.sourceKey;
  const current = () => {
    if (
      prepared.configuration(ctx, sourceIdentity) !== sourceConfig ||
      prepared.configuration(ctx, targetIdentity) !== targetConfig ||
      !queries.isCurrentCollection(sourceIdentity, source, sourceModel) ||
      !queries.isCurrentCollection(targetIdentity, target, targetModel) ||
      sourceModel.associations[name] !== association ||
      association.associationType !== associationType ||
      association.source !== sourceModel ||
      association.target !== targetModel ||
      association.sourceKey !== sourceKey ||
      association.foreignKey !== foreignKey ||
      targetModel.rawAttributes[foreignKey] !== attribute ||
      Reflect.ownKeys(association.scope ?? {}).length
    )
      invalid('Association identity or scope changed during authorization');
    for (const collection of db.collections.values())
      for (const entry of Object.values(collection.model.associations)) {
        const other = entry as typeof entry & {
          foreignKey?: string;
          sourceKey?: string;
          targetKey?: string;
          otherKey?: string;
          through?: { model?: typeof targetModel };
        };
        if (other === association) continue;
        if (
          (other.source === targetModel &&
            (other.associationType === 'BelongsTo'
              ? other.foreignKey === foreignKey && (other.target !== sourceModel || other.targetKey !== sourceKey)
              : other.sourceKey === foreignKey)) ||
          (other.target === targetModel &&
            (other.associationType === 'BelongsTo' || other.associationType === 'BelongsToMany'
              ? other.targetKey === foreignKey
              : other.foreignKey === foreignKey &&
                (other.associationType !== associationType ||
                  other.source !== sourceModel ||
                  other.sourceKey !== sourceKey))) ||
          (other.through?.model === targetModel && [other.foreignKey, other.otherKey].includes(foreignKey))
        )
          invalid('Foreign key also changes an unsupported relationship');
      }
  };
  current();
  return { source, target, sourceModel, targetModel, sourceConfig, targetConfig, foreignKey, current };
}
