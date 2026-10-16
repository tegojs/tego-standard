import { Op, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureExpansionRequest, normalizeExpansionKeys, type AccessExpansionRecord } from './expansion-page';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { internalQuery, invalid, normalizeKeys, unavailable } from './write-support';

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

/** Internal bounded-page expansion; entry adapters supply action/field ACL and parsed data predicates. */
export class AccessBelongsToExpansionService {
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
    request: BelongsToExpansionRequest,
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>> | null>> {
    const records = await this.read(ctx, source, target, authenticated, request, false);
    return new Map([...records].map(([key, record]) => [key, record?.values ?? null]));
  }

  /** Internal nested-assembly page; pairing keys are independent of output-field authorization. */
  page(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: BelongsToExpansionRequest,
  ) {
    return this.read(ctx, source, target, authenticated, request, true);
  }

  private async read(
    ctx: object,
    source: AccessCollectionIdentity,
    target: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: BelongsToExpansionRequest,
    pairing: boolean,
  ): Promise<ReadonlyMap<string, AccessExpansionRecord | null>> {
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
      invalid('Select a registered belongs-to association');
    const relation = resolveBelongsTo(this.db, this.prepared, this.queries, ctx, source, target, request.association);
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
      !Array.isArray(request.targetAttributes) ||
      (!pairing && !request.targetAttributes.length) ||
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
    current();
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
        // Fresh query values omit getters/internal keys; mutation input limits must not truncate authorized JSON.
        const values = record
          ? Object.freeze(Object.fromEntries(attributes.map((name) => [name, record.getDataValue(name)])))
          : null;
        return [
          key,
          record
            ? Object.freeze({
                key: normalizeKeys([record.getDataValue(targetPrimary)], relation.target)[0],
                values: values!,
              })
            : null,
        ] as const;
      }),
    );
  }
}
