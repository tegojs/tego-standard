import { Op, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import {
  captureExpansionRequest,
  mapExpansionValue,
  normalizeExpansionKeys,
  type AccessExpansionRecord,
  type AccessExpansionValue,
} from './expansion-page';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { resolveTargetForeignKey } from './target-foreign-key-metadata';
import { internalQuery, invalid, normalizeKeys, unavailable } from './write-support';

export interface TargetForeignKeyExpansionRequest {
  association: string;
  sourceKeys: Array<string | number>;
  /** Physical target fields already approved by the entry adapter's field ACL. */
  targetAttributes: string[];
  /** Trusted, server-parsed ACL/request predicates for the two collections independently. */
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  targetWhere?: WhereOptions;
  targetBind?: Record<string, unknown>;
  transaction?: Transaction;
}

type TargetValues = Readonly<Record<string, unknown>>;

/** Internal page expansion for HasMany/HasOne; entry adapters provide action and field ACL. */
export class AccessTargetForeignKeyExpansionService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly assertAuthorizationCurrent?: () => void,
  ) {}

  async load(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: TargetForeignKeyExpansionRequest,
  ): Promise<ReadonlyMap<string, readonly TargetValues[] | TargetValues | null>> {
    const records = await this.read(ctx, source, target, authenticated, request, false);
    return new Map([...records].map(([key, value]) => [key, mapExpansionValue(value, (record) => record.values)]));
  }

  /** Internal nested-assembly page; pairing keys are never output fields. */
  page(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: TargetForeignKeyExpansionRequest,
  ) {
    return this.read(ctx, source, target, authenticated, request, true);
  }

  private async read(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: TargetForeignKeyExpansionRequest,
    pairing: boolean,
  ): Promise<ReadonlyMap<string, AccessExpansionValue>> {
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
    request = captureExpansionRequest(request, allowed, pairing);
    const { transaction } = request;
    if (typeof request.association !== 'string' || !request.association)
      invalid('Select a registered target foreign-key association');
    const associationType = this.db.getCollection(source.collectionName)?.model.associations[request.association]
      ?.associationType;
    if (associationType !== 'HasMany' && associationType !== 'HasOne')
      invalid('Only HasMany and HasOne expansions are supported');
    const relation = resolveTargetForeignKey(
      this.db,
      this.prepared,
      this.queries,
      ctx,
      source,
      target,
      request.association,
      associationType,
      false,
    );
    const verifyMetadata = accessMetadataGuard(this.db, [
      { model: relation.sourceModel, config: relation.sourceConfig },
      { model: relation.targetModel, config: relation.targetConfig },
    ]);
    const current = () => {
      this.assertAuthorizationCurrent?.();
      relation.current();
      verifyMetadata();
    };
    const keys = normalizeExpansionKeys(request.sourceKeys, relation.source);
    if (
      (!pairing && !request.targetAttributes.length) ||
      request.targetAttributes.some(
        (name) =>
          typeof name !== 'string' ||
          !Object.hasOwn(relation.targetModel.rawAttributes, name) ||
          (relation.targetModel.rawAttributes[name].type as { key?: string }).key === 'VIRTUAL',
      )
    )
      invalid('Select explicit physical target attributes');
    const attributes = [...new Set(request.targetAttributes)];
    const sourcePrimary = relation.sourceModel.primaryKeyAttribute;
    const targetForeignKey = relation.foreignKey;
    const sourceConditions: WhereOptions[] = [{ [sourcePrimary]: { [Op.in]: keys } }];
    if (request.sourceWhere !== undefined) sourceConditions.push(request.sourceWhere);
    current();
    const sourceScope = await this.queries.scopeQuery(ctx, source, authenticated, {
      where: { [Op.and]: sourceConditions },
      bind: request.sourceBind,
      transaction,
    });
    current();
    if (!sourceScope || sourceScope.config !== relation.sourceConfig) invalid('Source expansion phase changed');
    const sources = await relation.sourceModel.findAll(
      internalQuery({ ...sourceScope.query, attributes: [sourcePrimary] }),
    );
    current();
    if (sources.length !== keys.length) unavailable();
    const targetConditions: WhereOptions[] = [{ [targetForeignKey]: { [Op.in]: keys } }];
    if (relation.scope !== undefined) targetConditions.push(relation.scope);
    if (request.targetWhere !== undefined) targetConditions.push(request.targetWhere);
    const targetScope = await this.queries.scopeQuery(ctx, target, authenticated, {
      where: { [Op.and]: targetConditions },
      bind: request.targetBind,
      transaction,
    });
    current();
    if (!targetScope || targetScope.config !== relation.targetConfig) invalid('Target expansion phase changed');
    const records = await relation.targetModel.findAll(
      internalQuery({
        ...targetScope.query,
        attributes: [...new Set([targetForeignKey, relation.targetModel.primaryKeyAttribute, ...attributes])],
        order: [[relation.targetModel.primaryKeyAttribute, 'ASC'] as [string, string]],
        limit: 10001,
      }),
    );
    current();
    if (records.length > 10000) invalid('Too many targets for a single expansion page');
    const grouped = new Map<string, AccessExpansionRecord[]>();
    for (const record of records) {
      const key = normalizeKeys([record.getDataValue(targetForeignKey)], relation.source)[0];
      // Fresh query values preserve authorized JSON without applying mutation input limits.
      const values = Object.freeze(Object.fromEntries(attributes.map((name) => [name, record.getDataValue(name)])));
      const list = grouped.get(key) ?? [];
      list.push(
        Object.freeze({
          key: normalizeKeys([record.getDataValue(relation.targetModel.primaryKeyAttribute)], relation.target)[0],
          values,
        }),
      );
      grouped.set(key, list);
    }
    const hasOne = associationType === 'HasOne';
    if (hasOne && [...grouped.values()].some((list) => list.length > 1)) invalid('HasOne target is not unique');
    return new Map(
      keys.map((key) => {
        const values = grouped.get(key) ?? [];
        return [key, hasOne ? (values[0] ?? null) : Object.freeze(values)] as const;
      }),
    );
  }
}
