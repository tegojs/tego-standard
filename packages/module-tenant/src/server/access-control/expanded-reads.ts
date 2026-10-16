import type { Collection, Database, Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import { AccessBelongsToExpansionService } from './belongs-to-expansion';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import {
  expansionRecords,
  mapExpansionValue,
  type AccessExpansionRecord,
  type AccessExpansionValue,
} from './expansion-page';
import { AccessManyToManyExpansionService } from './many-to-many-expansion';
import { resolveManyToManyRead } from './many-to-many-read-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { AccessReadService, type AccessGetRequest, type AccessListRequest } from './reads';
import type { AccessFilterGrantResolver, AccessFilterReadGrant } from './request-filter';
import { AccessTargetForeignKeyExpansionService } from './target-foreign-key-expansion';
import { resolveTargetForeignKey } from './target-foreign-key-metadata';
import { cloneDeep, invalid, plain } from './write-support';

export interface AccessExpandedListRequest extends AccessListRequest {
  expansions: unknown;
}

export interface AccessExpandedGetRequest extends AccessGetRequest {
  expansions: unknown;
}

type ReadRecord = Readonly<Record<string, unknown>>;
interface ExpansionSelection {
  association: string;
  attributes: string[];
  expansions: ExpansionSelection[];
}
interface ExpansionPlan {
  name: string;
  children: ExpansionPlan[];
  load(keys: string[]): Promise<ReadonlyMap<string, AccessExpansionValue>>;
}
interface AssembledRecord {
  values: ReadRecord;
  size: number;
}

/** Bounded nested assembly. Capture every path's permissions and metadata before querying the root. */
export class AccessExpandedReadService {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveGrant: AccessFilterGrantResolver,
    private readonly assertAuthorizationCurrent?: () => void,
  ) {}

  list(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessExpandedListRequest,
  ) {
    return this.read(ctx, source, authenticated, request, 'list');
  }

  async get(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessExpandedGetRequest,
  ) {
    return (await this.read(ctx, source, authenticated, request, 'get'))[0] ?? null;
  }

  private async read(
    ctx: object,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    request: AccessExpandedListRequest | AccessExpandedGetRequest,
    kind: 'list' | 'get',
  ): Promise<ReadRecord[]> {
    const allowed = [
      'attributes',
      'filter',
      'transaction',
      'expansions',
      ...(kind === 'list' ? ['sort', 'limit', 'offset'] : ['key']),
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
      invalid('Unsupported expanded root read request');
    const dense = (input: unknown, maximum: number, allowEmpty = false): unknown[] => {
      if (
        !Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        (!allowEmpty && !input.length) ||
        input.length > maximum ||
        Reflect.ownKeys(input).length !== input.length + 1
      )
        invalid('Expansion arrays must be bounded and dense');
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, index);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Expansion arrays cannot contain accessors');
      }
      return input;
    };
    let nodes = 0;
    const select = (values: unknown, depth: number): ExpansionSelection[] => {
      if (depth > 3) invalid('Expand at most three association levels');
      const names = new Set<string>();
      return dense(values, 20).map((input) => {
        if (++nodes > 20) invalid('Expand at most 20 association paths');
        if (
          !plain(input) ||
          !Object.hasOwn(input, 'association') ||
          !Object.hasOwn(input, 'attributes') ||
          Reflect.ownKeys(input).some(
            (key) =>
              typeof key !== 'string' ||
              !['association', 'attributes', 'expansions'].includes(key) ||
              !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'),
          )
        )
          invalid('Select an association and explicit target attributes');
        const name = input.association;
        if (typeof name !== 'string' || !name || name.includes('.') || names.has(name))
          invalid('Select distinct direct associations');
        names.add(name);
        const expansions = Object.hasOwn(input, 'expansions') ? select(input.expansions, depth + 1) : [];
        const attributes = dense(input.attributes, 1000, expansions.length > 0);
        if (attributes.some((field) => typeof field !== 'string') || new Set(attributes).size !== attributes.length)
          invalid('Select distinct physical target attributes');
        return { association: name, attributes: [...attributes] as string[], expansions };
      });
    };
    const selections = select(request.expansions, 1);
    const transaction = request.transaction as Transaction | undefined;
    // Root planning validates and snapshots these original values synchronously before its first await.
    // Do not clone first: cloning would normalize unsupported array prototypes before validation.
    const rootRequest = {
      ...Object.fromEntries(
        Reflect.ownKeys(request)
          .filter((key) => key !== 'expansions' && key !== 'transaction')
          .map((key) => [key, Object.getOwnPropertyDescriptor(request, key)!.value]),
      ),
      transaction,
    } as unknown as AccessListRequest | AccessGetRequest;
    source = { ...source };
    authenticated = { ...authenticated };
    const collection = this.db.getCollection(source.collectionName);
    if (!collection || !this.queries.isCurrentCollection(source, collection))
      invalid('Expanded reads require a current source collection');
    const grants = new Map<string, { collection: Collection; grant: AccessFilterReadGrant | null }>();
    const resolveGrant: AccessFilterGrantResolver = (target, path) => {
      const key = JSON.stringify(path);
      const previous = grants.get(key);
      if (previous) {
        if (previous.collection !== target) invalid('Expansion grant path changed its collection');
        return previous.grant;
      }
      const grant = cloneDeep(this.resolveGrant(target, Object.freeze([...path])));
      if (
        grant &&
        (grant.identity.collectionName !== target.name || !this.queries.isCurrentCollection(grant.identity, target))
      )
        invalid('Expansion permission does not match its collection');
      grants.set(key, { collection: target, grant });
      return grant;
    };
    const sourceGrant = resolveGrant(collection, []);
    if (!sourceGrant || accessCollectionKey(sourceGrant.identity) !== accessCollectionKey(source))
      invalid('Source expansion is not authorized');
    const checks: Array<() => void> = [];
    const current = () => {
      this.assertAuthorizationCurrent?.();
      for (const check of checks) check();
    };
    const prepare = (
      source: AccessCollectionIdentity,
      collection: Collection,
      sourceGrant: AccessFilterReadGrant,
      selections: ExpansionSelection[],
      path: readonly string[],
    ): ExpansionPlan[] =>
      selections.map((selection) => {
        const name = selection.association;
        const association = Object.hasOwn(collection.model.associations, name)
          ? collection.model.associations[name]
          : undefined;
        const target = association && this.db.modelCollection.get(association.target);
        if (!association || !target || target.db !== this.db || Object.hasOwn(collection.model.rawAttributes, name))
          invalid('Select a registered same-database association');
        const targetPath = [...path, name];
        const targetGrant = resolveGrant(target, targetPath);
        if (!sourceGrant.fields.includes(name) || !targetGrant) invalid('Association expansion is not authorized');
        if (
          selection.attributes.some(
            (field) =>
              !targetGrant.fields.includes(field) ||
              !Object.hasOwn(target.model.rawAttributes, field) ||
              (target.model.rawAttributes[field].type as { key?: string }).key === 'VIRTUAL',
          )
        )
          invalid('Expansion attributes must be authorized physical target fields');
        const input = {
          association: name,
          targetAttributes: selection.attributes,
          transaction,
          sourceWhere: sourceGrant.where,
          sourceBind: sourceGrant.bind,
          targetWhere: targetGrant.where,
          targetBind: targetGrant.bind,
        };
        const type = association.associationType;
        let load: ExpansionPlan['load'];
        if (type === 'BelongsToMany') {
          const throughModel = (association as typeof association & { through?: { model?: Collection['model'] } })
            .through?.model;
          const through = throughModel && this.db.modelCollection.get(throughModel);
          if (!through || through.db !== this.db) invalid('Expansion through collection is unavailable');
          const throughGrant = resolveGrant(through, [...targetPath, '$through']);
          if (!throughGrant) invalid('Through expansion is not authorized');
          const relation = resolveManyToManyRead(
            this.db,
            this.prepared,
            this.queries,
            ctx,
            source,
            targetGrant.identity,
            throughGrant.identity,
            name,
          );
          checks.push(
            relation.current,
            accessMetadataGuard(
              this.db,
              [relation.sourceModel, relation.targetModel, relation.throughModel].map((model, index) => ({
                model,
                config: relation.configs[index]!,
              })),
            ),
          );
          load = (keys) =>
            new AccessManyToManyExpansionService(this.db, this.prepared, this.queries, current).page(
              ctx,
              source,
              targetGrant.identity,
              throughGrant.identity,
              authenticated,
              { ...input, sourceKeys: keys, throughWhere: throughGrant.where, throughBind: throughGrant.bind },
            );
        } else if (type === 'BelongsTo' || type === 'HasMany' || type === 'HasOne') {
          const relation =
            type === 'BelongsTo'
              ? resolveBelongsTo(this.db, this.prepared, this.queries, ctx, source, targetGrant.identity, name)
              : resolveTargetForeignKey(
                  this.db,
                  this.prepared,
                  this.queries,
                  ctx,
                  source,
                  targetGrant.identity,
                  name,
                  type,
                  false,
                );
          checks.push(
            relation.current,
            accessMetadataGuard(this.db, [
              { model: relation.sourceModel, config: relation.sourceConfig },
              { model: relation.targetModel, config: relation.targetConfig },
            ]),
          );
          load = (keys) =>
            (type === 'BelongsTo'
              ? new AccessBelongsToExpansionService(this.db, this.prepared, this.queries, current)
              : new AccessTargetForeignKeyExpansionService(this.db, this.prepared, this.queries, current)
            ).page(ctx, source, targetGrant.identity, authenticated, { ...input, sourceKeys: keys });
        } else invalid('Unsupported expansion association type');
        return {
          name,
          load,
          children: prepare(targetGrant.identity, target, targetGrant, selection.expansions, targetPath),
        };
      });
    const loaders = prepare(source, collection, sourceGrant, selections, []);
    current();
    const page = await new AccessReadService(this.db, this.prepared, this.queries, resolveGrant, current).page(
      ctx,
      source,
      authenticated,
      rootRequest,
      kind,
    );
    const assertCurrent = () => {
      current();
      page.assertCurrent();
    };
    assertCurrent();
    const assemble = async (
      records: readonly AccessExpansionRecord[],
      plans: ExpansionPlan[],
    ): Promise<Map<string, AssembledRecord>> => {
      const keys = [...new Set(records.map((record) => record.key))];
      const expanded: Array<{
        name: string;
        values: ReadonlyMap<string, AccessExpansionValue>;
        targets: Map<string, AssembledRecord>;
      }> = [];
      for (const plan of plans) {
        const values = await plan.load(keys);
        assertCurrent();
        const targets = new Map<string, AccessExpansionRecord>();
        for (const value of values.values())
          for (const record of expansionRecords(value)) targets.set(record.key, record);
        const assembled = await assemble([...targets.values()], plan.children);
        assertCurrent();
        expanded.push({ name: plan.name, values, targets: assembled });
      }
      let totalSize = 0;
      return new Map(
        records.map((record) => {
          let size = 1;
          const values = Object.freeze(
            Object.fromEntries([
              ...Object.entries(record.values),
              ...expanded.map(({ name, values, targets }) => {
                const value = values.get(record.key);
                if (value === undefined) invalid('Expansion page is missing a source pairing');
                for (const target of expansionRecords(value)) size += targets.get(target.key)!.size;
                // Count repeated serialized subtrees, not just the shared in-memory object identities.
                if (size > 100000) invalid('Expanded response exceeds record limit');
                return [name, mapExpansionValue(value, (target) => targets.get(target.key)!.values)];
              }),
            ]),
          );
          totalSize += size;
          if (totalSize > 100000) invalid('Expanded response exceeds record limit');
          return [record.key, { values, size }];
        }),
      );
    };
    const result = await assemble(page.records, loaders);
    assertCurrent();
    return page.records.map((record) => result.get(record.key)!.values);
  }
}
