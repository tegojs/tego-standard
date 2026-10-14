import { isDeepStrictEqual } from 'node:util';
import type { Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessQueryService } from './query';
import { cloneDeep, invalid } from './write-support';

/** Read metadata is separate from pure-link writes: business through rows have their own read scope. */
export function resolveManyToManyRead(
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
    invalid('Cross-data-source association reads are unsupported');
  const identities = [sourceIdentity, targetIdentity, throughIdentity];
  const configs = identities.map((identity) => prepared.configuration(ctx, identity));
  if (configs.some((config) => !config))
    invalid('All three relation collections require prepared access configurations');
  const collections = identities.map((identity) => db.getCollection(identity.collectionName));
  if (collections.some((collection) => !collection)) invalid('Association collection is unavailable');
  const [source, target, through] = collections;
  const [sourceModel, targetModel, throughModel] = collections.map((collection) => collection.model);
  const association = sourceModel.associations[name] as (typeof sourceModel.associations)[string] & {
    sourceKey?: string;
    targetKey?: string;
    foreignKey?: string;
    otherKey?: string;
    scope?: Record<string, unknown>;
    through?: { model?: typeof sourceModel; scope?: Record<string, unknown>; paranoid?: boolean };
  };
  if (
    !association ||
    association.associationType !== 'BelongsToMany' ||
    association.source !== sourceModel ||
    association.target !== targetModel ||
    association.through?.model !== throughModel ||
    new Set([sourceModel, targetModel, throughModel]).size !== 3 ||
    new Set([sourceModel.name, targetModel.name, throughModel.name]).size !== 3 ||
    [sourceModel, targetModel, throughModel].some((model) => model.sequelize !== db.sequelize) ||
    sourceModel.primaryKeyAttributes.length !== 1 ||
    targetModel.primaryKeyAttributes.length !== 1 ||
    association.sourceKey !== sourceModel.primaryKeyAttribute ||
    association.targetKey !== targetModel.primaryKeyAttribute
  )
    invalid(
      'Only registered same-database many-to-many reads between distinct single-primary-key models are supported',
    );
  const foreignKey = association.foreignKey!;
  const otherKey = association.otherKey!;
  if (
    !foreignKey ||
    !otherKey ||
    foreignKey === otherKey ||
    !throughModel.rawAttributes[foreignKey] ||
    !throughModel.rawAttributes[otherKey]
  )
    invalid('Join keys are unavailable');
  const scope = cloneDeep(association.scope);
  const throughScope = cloneDeep(association.through?.scope);
  const throughParanoid = association.through?.paranoid;
  if (throughParanoid === false && throughModel.options.paranoid)
    invalid('Association cannot bypass through soft deletion');
  const models = [sourceModel, targetModel, throughModel];
  const signatures = () =>
    models.map((model) => ({
      primaryKey: [...model.primaryKeyAttributes],
      table: model.getTableName(),
      attributes: Object.fromEntries(
        Object.entries(model.rawAttributes).map(([key, attr]) => [key, attr.field || key]),
      ),
      scope: (model as unknown as { _scope: unknown })._scope,
      paranoid: model.options.paranoid,
      deletedAt: (model as unknown as { _timestampAttributes?: { deletedAt?: string } })._timestampAttributes
        ?.deletedAt,
    }));
  const snapshot = cloneDeep(signatures());
  const current = () => {
    if (
      identities.some(
        (identity, i) =>
          prepared.configuration(ctx, identity) !== configs[i] ||
          !queries.isCurrentCollection(identity, collections[i], models[i]),
      ) ||
      sourceModel.associations[name] !== association ||
      association.associationType !== 'BelongsToMany' ||
      association.source !== sourceModel ||
      association.target !== targetModel ||
      association.through?.model !== throughModel ||
      association.sourceKey !== sourceModel.primaryKeyAttribute ||
      association.targetKey !== targetModel.primaryKeyAttribute ||
      association.foreignKey !== foreignKey ||
      association.otherKey !== otherKey ||
      association.through?.paranoid !== throughParanoid ||
      !isDeepStrictEqual(association.scope, scope) ||
      !isDeepStrictEqual(association.through?.scope, throughScope) ||
      !isDeepStrictEqual(signatures(), snapshot)
    )
      invalid('Association identity or scope changed during authorization');
  };
  current();
  return {
    source,
    target,
    through,
    sourceModel,
    targetModel,
    throughModel,
    configs,
    foreignKey,
    otherKey,
    scope,
    throughScope,
    current,
  };
}
