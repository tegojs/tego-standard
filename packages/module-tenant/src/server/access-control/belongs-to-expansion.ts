import { isDeepStrictEqual } from 'node:util';
import { Op, type Database, type Model, type ModelStatic, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessQueryService } from './query';
import { cloneDeep, internalQuery, invalid, normalizeKeys, plain, unavailable } from './write-support';

export interface BelongsToExpansionRequest {
  association: string;
  sourceKeys: Array<string | number>;
  /** Explicit physical attributes already approved by the entry adapter's target-field ACL. */
  targetAttributes: string[];
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  transaction?: Transaction;
}

/** Detect in-place column/default-scope changes as well as model replacement across awaits. */
function modelSnapshot(model: ModelStatic<Model>) {
  const runtime = model as unknown as { _scope: unknown; _timestampAttributes: { deletedAt?: string } };
  const deletedAt = runtime._timestampAttributes.deletedAt;
  return cloneDeep({
    table: model.getTableName(),
    primary: model.primaryKeyAttributes,
    attributes: Object.entries(model.rawAttributes).map(([name, attribute]) => [
      name,
      attribute.field,
      (attribute.type as { key?: string }).key,
      attribute.primaryKey,
    ]),
    scope: runtime._scope,
    paranoid: model.options.paranoid,
    deletedAt,
    deletedDefault: deletedAt ? model.rawAttributes[deletedAt]?.defaultValue : undefined,
  });
}

function databaseMetadataSnapshot(db: Database) {
  return [...db.collections.values()]
    .map((collection) => ({
      name: collection.name,
      model: modelSnapshot(collection.model),
      associations: Object.entries(collection.model.associations)
        .map(([name, association]) => {
          const relation = association as typeof association & {
            foreignKey?: string;
            sourceKey?: string;
            targetKey?: string;
            otherKey?: string;
            scope?: unknown;
            through?: { model?: ModelStatic<Model>; scope?: unknown };
          };
          return {
            name,
            type: relation.associationType,
            source: relation.source?.name,
            target: relation.target?.name,
            foreignKey: relation.foreignKey,
            sourceKey: relation.sourceKey,
            targetKey: relation.targetKey,
            otherKey: relation.otherKey,
            scope: cloneDeep(relation.scope),
            through: relation.through
              ? { model: relation.through.model?.name, scope: cloneDeep(relation.through.scope) }
              : undefined,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Internal bounded-page expansion; entry adapters supply action/field ACL and parsed data predicates. */
export class AccessBelongsToExpansionService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
  ) {}

  async load(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: BelongsToExpansionRequest,
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>> | null>> {
    source = { ...source };
    target = { ...target };
    authenticated = { ...authenticated };
    const allowed = [
      'association',
      'sourceKeys',
      'targetAttributes',
      'sourceWhere',
      'sourceBind',
      'targetWhere',
      'targetBind',
      'transaction',
    ];
    if (
      !plain(request) ||
      Reflect.ownKeys(request).some(
        (key) =>
          typeof key !== 'string' ||
          !allowed.includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(request, key)!, 'value'),
      )
    )
      invalid('Unsupported association expansion input');
    for (const name of ['sourceKeys', 'targetAttributes'] as const) {
      const values = request[name];
      if (!Array.isArray(values) || values.length > 1000) invalid('Supply a bounded explicit expansion array');
      for (let index = 0; index < values.length; index++)
        if (!Object.hasOwn(values, index)) invalid('Expansion arrays cannot contain missing entries');
    }
    const { transaction, ...input } = request;
    request = { ...cloneDeep(input), transaction };
    if (typeof request.association !== 'string' || !request.association)
      invalid('Select a registered belongs-to association');
    const relation = resolveBelongsTo(this.db, this.prepared, this.queries, ctx, source, target, request.association);
    const sourceSnapshot = modelSnapshot(relation.sourceModel);
    const targetSnapshot = modelSnapshot(relation.targetModel);
    const databaseSnapshot = databaseMetadataSnapshot(this.db);
    const current = () => {
      relation.current();
      if (
        !isDeepStrictEqual(sourceSnapshot, modelSnapshot(relation.sourceModel)) ||
        !isDeepStrictEqual(targetSnapshot, modelSnapshot(relation.targetModel)) ||
        !isDeepStrictEqual(databaseSnapshot, databaseMetadataSnapshot(this.db))
      )
        invalid('Expansion model metadata changed during authorization');
    };
    if (!Array.isArray(request.sourceKeys) || request.sourceKeys.length > 1000)
      invalid('Expand at most 1000 explicit source keys');
    const keys = request.sourceKeys.length ? normalizeKeys(request.sourceKeys, relation.source) : [];
    if (
      !Array.isArray(request.targetAttributes) ||
      !request.targetAttributes.length ||
      request.targetAttributes.length > 1000 ||
      request.targetAttributes.some((name) => {
        if (typeof name !== 'string' || !Object.hasOwn(relation.targetModel.rawAttributes, name)) return true;
        return (relation.targetModel.rawAttributes[name].type as { key?: string }).key === 'VIRTUAL';
      })
    )
      invalid('Select explicit physical target attributes');
    const attributes = [...new Set(request.targetAttributes)];
    const sourcePrimary = relation.sourceModel.primaryKeyAttribute;
    const targetPrimary = relation.targetModel.primaryKeyAttribute;
    const sourceConditions: WhereOptions[] = [{ [sourcePrimary]: { [Op.in]: keys } }];
    if (request.sourceWhere !== undefined) sourceConditions.push(request.sourceWhere);
    const sourceScope = await this.queries.scopeQuery(ctx, source, authenticated, {
      where: { [Op.and]: sourceConditions },
      bind: request.sourceBind,
      transaction,
    });
    current();
    if (!sourceScope || sourceScope.config !== relation.sourceConfig) invalid('Source expansion phase changed');
    const sources = await relation.sourceModel.findAll(
      internalQuery({
        ...sourceScope.query,
        attributes: [sourcePrimary, relation.foreignKey],
      }),
    );
    current();
    if (sources.length !== keys.length) unavailable();
    const foreignKeys = new Map(
      sources.map((record) => {
        const foreign = record.getDataValue(relation.foreignKey);
        return [
          normalizeKeys([record.getDataValue(sourcePrimary)], relation.source)[0],
          foreign == null ? null : normalizeKeys([foreign], relation.target)[0],
        ] as const;
      }),
    );
    const targetKeys = [...new Set([...foreignKeys.values()].filter((key): key is string => key !== null))];
    const targetConditions: WhereOptions[] = [{ [targetPrimary]: { [Op.in]: targetKeys } }];
    if (relation.scope !== undefined) targetConditions.push(relation.scope);
    if (request.targetWhere !== undefined) targetConditions.push(request.targetWhere);
    const targetScope = await this.queries.scopeQuery(ctx, target, authenticated, {
      where: { [Op.and]: targetConditions },
      bind: request.targetBind,
      transaction,
    });
    current();
    if (!targetScope || targetScope.config !== relation.targetConfig) invalid('Target expansion phase changed');
    const targets = await relation.targetModel.findAll(
      internalQuery({
        ...targetScope.query,
        attributes: [...new Set([targetPrimary, ...attributes])],
      }),
    );
    current();
    const readable = new Map(
      targets.map((record) => [normalizeKeys([record.getDataValue(targetPrimary)], relation.target)[0], record]),
    );
    return new Map(
      keys.map((key) => {
        const foreign = foreignKeys.get(key);
        const record = foreign == null ? undefined : readable.get(foreign);
        // Raw values omit virtual/custom getters and internal pairing keys not explicitly selected.
        const values = record
          ? Object.freeze(Object.fromEntries(attributes.map((name) => [name, cloneDeep(record.getDataValue(name))])))
          : null;
        return [key, values] as const;
      }),
    );
  }
}
