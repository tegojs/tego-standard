import { isDeepStrictEqual } from 'node:util';
import { literal, Op, type Collection, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService, ScopedAccessQuery } from './query';
import type { AccessFilterGrantResolver, AccessFilterReadGrant } from './request-filter';
import { assertAccessSortScalarField, captureAccessSortFields, resolveAccessSortTarget } from './sort-fields';
import type { AccessConfig } from './types';
import { cloneDeep, invalid, plain } from './write-support';

export interface AccessSortRequest {
  /** Untrusted field names, optionally prefixed with '-' for descending order. */
  sort: unknown;
  /** Already parsed on the server, never raw client authorization predicates. */
  sourceWhere?: WhereOptions;
  sourceBind?: Record<string, unknown>;
  transaction?: Transaction;
}

export interface AccessSortPlan extends ScopedAccessQuery {
  query: ScopedAccessQuery['query'] & { order: Array<ReturnType<typeof literal>> };
  /** Reuse for count/sum: contains no order-only target bindings. */
  rootQuery: ScopedAccessQuery['query'];
  assertCurrent(): void;
}

export interface PreparedAccessSort {
  readonly reservedBindNames: readonly string[];
  /** Additional trusted predicates from a filter plan compiled after preparation. */
  scopeRoots(predicate?: Pick<AccessSortRequest, 'sourceWhere' | 'sourceBind'>): Promise<AccessSortPlan>;
  assertCurrent(): void;
}

interface CapturedSortCollection {
  collection: Collection;
  model: Collection['model'];
  grant: AccessFilterReadGrant;
  config: AccessConfig;
}

interface SortAssociation {
  target: CapturedSortCollection;
  relation: ReturnType<typeof resolveBelongsTo>;
}

/** Internal ordering plan; does not register actions or infer entry ACL permissions. */
export class AccessSortService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveGrant: AccessFilterGrantResolver,
  ) {}

  async scopeRoots(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessSortRequest,
  ): Promise<AccessSortPlan> {
    return this.prepareRoots(ctx, source, authenticated, request).scopeRoots();
  }

  /** Capture the entire ordering authorization synchronously, before filter compilation can await. */
  prepareRoots(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessSortRequest,
  ): PreparedAccessSort {
    if (
      !plain(request) ||
      Reflect.ownKeys(request).some(
        (key) =>
          typeof key !== 'string' ||
          !['sort', 'sourceWhere', 'sourceBind', 'transaction'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(request, key)!, 'value'),
      )
    )
      invalid('Unsupported sort request');
    // Inspect descriptors before reading any untrusted array element or invoking a grant resolver.
    const fields = captureAccessSortFields(request.sort);
    source = { ...source };
    authenticated = { ...authenticated };
    const { transaction, ...values } = request;
    const snapshot = cloneDeep({ sourceWhere: values.sourceWhere, sourceBind: values.sourceBind });
    const captured = new Map<string, CapturedSortCollection>();
    const associations = new Map<string, SortAssociation>();
    const bind: Record<string, unknown> = {};
    const reserveBindings = (bind: Record<string, unknown>, bindings: Record<string, unknown> | undefined) => {
      if (bindings === undefined) return;
      if (!plain(bindings)) invalid('Sort SQL bindings must be named');
      for (const key of Reflect.ownKeys(bindings)) {
        if (
          typeof key !== 'string' ||
          !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ||
          ['__proto__', 'constructor', 'prototype'].includes(key) ||
          (Object.hasOwn(bind, key) && !isDeepStrictEqual(bind[key], bindings[key]))
        )
          invalid('Sort SQL binding names or values conflict');
        bind[key] = bindings[key];
      }
    };
    reserveBindings(bind, snapshot.sourceBind);
    const capture = (collection: Collection, path: string[], expected?: AccessCollectionIdentity) => {
      const pathKey = path.join('.');
      const previous = captured.get(pathKey);
      if (previous) return previous;
      const resolved = this.resolveGrant(collection, Object.freeze([...path]));
      if (!resolved) invalid('Sort field or association is not authorized');
      const grant = cloneDeep(resolved);
      if (
        grant.identity.collectionName !== collection.name ||
        grant.identity.dataSourceKey !== source.dataSourceKey ||
        (expected && !isDeepStrictEqual(grant.identity, expected)) ||
        !Array.isArray(grant.fields) ||
        grant.fields.some((name) => typeof name !== 'string') ||
        !this.queries.isCurrentCollection(grant.identity, collection)
      )
        invalid('Sort grant does not match its registered collection');
      const config = this.prepared.configuration(ctx, grant.identity);
      if (!config) invalid('Sort collections require a prepared access configuration');
      reserveBindings(bind, grant.bind);
      const entry = { collection, model: collection.model, grant, config };
      captured.set(pathKey, entry);
      return entry;
    };
    const collection = this.db.getCollection(source.collectionName);
    if (!collection) invalid('Sort source collection is unavailable');
    const root = capture(collection, [], source);
    const rootBind = { ...bind };
    if (root.model.primaryKeyAttributes.length !== 1) invalid('Stable sorting requires a single root primary key');
    const parsed = fields.map(({ parts, direction }) => {
      let current = root;
      const chain: SortAssociation[] = [];
      const path: string[] = [];
      for (const part of parts.slice(0, -1)) {
        if (!current.grant.fields.includes(part)) invalid('Sort association field is not authorized');
        const target = resolveAccessSortTarget(this.db, current.model, part);
        path.push(part);
        const key = path.join('.');
        let entry = associations.get(key);
        if (!entry) {
          const targetEntry = capture(target, path);
          const relation = resolveBelongsTo(
            this.db,
            this.prepared,
            this.queries,
            ctx,
            current.grant.identity,
            targetEntry.grant.identity,
            part,
          );
          entry = { target: targetEntry, relation };
          associations.set(key, entry);
        }
        chain.push(entry);
        current = entry.target;
      }
      const field = parts.at(-1)!;
      if (!current.grant.fields.includes(field)) invalid('Sort requires an authorized physical scalar field');
      assertAccessSortScalarField(current.model, field);
      return { field, model: current.model, chain, direction };
    });
    const metadataCurrent = accessMetadataGuard(
      this.db,
      [...captured.values()].map(({ model, config }) => ({ model, config })),
    );
    const assertCurrent = () => {
      for (const entry of captured.values()) {
        if (
          this.prepared.configuration(ctx, entry.grant.identity) !== entry.config ||
          !this.queries.isCurrentCollection(entry.grant.identity, entry.collection, entry.model)
        )
          invalid('Sort collection phase or identity changed');
      }
      for (const { relation } of associations.values()) relation.current();
      metadataCurrent();
    };
    assertCurrent();
    const capturedBind = { ...bind };
    return {
      assertCurrent,
      reservedBindNames: Object.freeze(Object.keys(capturedBind)),
      scopeRoots: async (predicate = {}) => {
        if (
          !plain(predicate) ||
          Reflect.ownKeys(predicate).some(
            (key) =>
              typeof key !== 'string' ||
              !['sourceWhere', 'sourceBind'].includes(key) ||
              !Object.hasOwn(Object.getOwnPropertyDescriptor(predicate, key)!, 'value'),
          )
        )
          invalid('Unsupported additional sort predicate');
        predicate = cloneDeep(predicate);
        let bind = { ...capturedBind };
        reserveBindings(bind, predicate.sourceBind);
        const additionalRootBind = { ...rootBind };
        reserveBindings(additionalRootBind, predicate.sourceBind);
        assertCurrent();
        const qi = this.db.sequelize.getQueryInterface();
        const quote = (name: string) => qi.quoteIdentifier(name);
        const column = (model: Collection['model'], field: string) =>
          `${quote(model.name)}.${quote(model.rawAttributes[field].field || field)}`;
        const generator = qi.queryGenerator as unknown as {
          selectQuery(
            table: ReturnType<Collection['model']['getTableName']>,
            options: object,
            model: Collection['model'],
          ): string;
        };
        const orm = this.db.sequelize.constructor as unknown as {
          Utils: { mapOptionFieldNames<T extends object>(options: T, model: Collection['model']): T };
        };
        const usedAliases = new Set([...captured.values()].map(({ model }) => model.name.toLowerCase()));
        let aliasIndex = 0;
        const nextAlias = () => {
          let alias: string;
          do {
            alias = `tac_sort_${aliasIndex++}`;
          } while (usedAliases.has(alias.toLowerCase()));
          usedAliases.add(alias.toLowerCase());
          return alias;
        };
        const conditions: WhereOptions[] = [];
        if (root.grant.where !== undefined) conditions.push(root.grant.where);
        if (snapshot.sourceWhere !== undefined) conditions.push(snapshot.sourceWhere);
        if (predicate.sourceWhere !== undefined) conditions.push(predicate.sourceWhere);
        const scoped = await this.queries.scopeQuery(ctx, source, authenticated, {
          where: { [Op.and]: conditions },
          bind,
          transaction,
        });
        assertCurrent();
        if (!scoped || scoped.config !== root.config) invalid('Sort root scope phase changed');
        bind = scoped.query.bind!;
        const rootQuery = { ...scoped.query, bind: { ...additionalRootBind, ...scoped.scopes.read.bind } };
        const scopedTargets = new Map<SortAssociation, WhereOptions>();
        for (const entry of associations.values()) {
          const conditions: WhereOptions[] = [];
          if (entry.target.grant.where !== undefined) conditions.push(entry.target.grant.where);
          if (entry.relation.scope !== undefined) conditions.push(entry.relation.scope);
          const scoped = await this.queries.scopeQuery(ctx, entry.target.grant.identity, authenticated, {
            where: { [Op.and]: conditions },
            bind,
            transaction,
          });
          assertCurrent();
          if (!scoped || scoped.config !== entry.target.config) invalid('Sort target scope phase changed');
          bind = scoped.query.bind!;
          scopedTargets.set(entry, scoped.query.where!);
        }
        const order = parsed.map(({ field, model, chain, direction }) => {
          let expression = column(model, field);
          for (const entry of [...chain].reverse()) {
            const target = entry.target.model;
            const options = orm.Utils.mapOptionFieldNames(
              {
                tableAs: target.name,
                attributes: [
                  literal(`${column(target, target.primaryKeyAttribute)} AS ${quote('match_key')}`),
                  literal(`${expression} AS ${quote('sort_value')}`),
                ],
                where: scopedTargets.get(entry),
              },
              target,
            );
            const sql = generator.selectQuery(target.getTableName(), options, target).replace(/;\s*$/, '');
            const alias = quote(nextAlias());
            expression = `(SELECT ${alias}.${quote('sort_value')} FROM (${sql}) AS ${alias} WHERE ${alias}.${quote('match_key')} = ${column(entry.relation.sourceModel, entry.relation.foreignKey)})`;
          }
          // Both supported dialects implement NULLS LAST; inaccessible values cannot affect ordering.
          return literal(`${expression} ${direction} NULLS LAST`);
        });
        // The internal tiebreaker is not projected and does not authorize querying a hidden field.
        order.push(literal(`${column(root.model, root.model.primaryKeyAttribute)} ASC`));
        assertCurrent();
        return { ...scoped, query: { ...scoped.query, bind, order }, rootQuery, assertCurrent };
      },
    };
  }
}
