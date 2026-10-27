import { isDeepStrictEqual } from 'node:util';
import { Op, type BelongsToManyRepository, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { guardJoinWrite } from './join-write-guard';
import { resolveManyToMany } from './many-to-many-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { AccessReferenceService } from './references';
import { cloneDeep, internalQuery, invalid, normalizeKeys, plain } from './write-support';

export interface AccessCreationLink {
  association: string;
  target: AccessCollectionIdentity;
  through: AccessCollectionIdentity;
  keys: Array<string | number>;
  where?: WhereOptions;
}

export function assertCreationKeyArray(value: unknown): asserts value is Array<string | number> {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 1000 ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(value, index))
  )
    invalid('Creation links require a bounded dense key array');
}

function dense(input: unknown, limit: number): asserts input is unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > limit ||
    Reflect.ownKeys(input).length !== input.length + 1 ||
    Array.from({ length: input.length }, (_, index) => index).some((index) => !Object.hasOwn(input, index))
  )
    invalid('Creation links require bounded dense row lists');
}

/** Pure joins only. The caller owns the source INSERT receipts, transaction and final source checks. */
function prepareRows(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  ctx: object,
  source: AccessCollectionIdentity,
  links: AccessCreationLink[][],
  original: AccessCreationLink[][],
  limit: number,
  batched: boolean,
) {
  dense(links, 1000);
  dense(original, 1000);
  if (links.length !== original.length) invalid('Creation link row snapshots do not match');
  const joins = new Map<object, string>();
  const relations = new Map<
    string,
    {
      target: AccessCollectionIdentity;
      through: AccessCollectionIdentity;
      relation: ReturnType<typeof resolveManyToMany>;
    }
  >();
  const plans = links.map((row, rowIndex) => {
    dense(row, limit);
    dense(original[rowIndex], limit);
    const names = new Set<string>();
    return row.map((link, index) => {
      if (
        !plain(link) ||
        typeof link.association !== 'string' ||
        names.has(link.association) ||
        Reflect.ownKeys(link).some(
          (key) => typeof key !== 'string' || !['association', 'target', 'through', 'keys', 'where'].includes(key),
        )
      )
        invalid('Creation links require registered association names');
      names.add(link.association);
      assertCreationKeyArray(original[rowIndex][index].keys);
      assertCreationKeyArray(link.keys);
      let selected = relations.get(link.association);
      if (!selected) {
        const relation = resolveManyToMany(
          db,
          prepared,
          queries,
          ctx,
          source,
          link.target,
          link.through,
          link.association,
        );
        const other = joins.get(relation.throughModel);
        if (other !== undefined && other !== link.association)
          invalid('Creation links cannot use overlapping join tables');
        joins.set(relation.throughModel, link.association);
        selected = { relation, target: cloneDeep(link.target), through: cloneDeep(link.through) };
        relations.set(link.association, selected);
      } else if (
        !plain(link.target) ||
        !plain(link.through) ||
        accessCollectionKey(link.target) !== accessCollectionKey(selected.target) ||
        link.target.collectionName !== selected.target.collectionName ||
        accessCollectionKey(link.through) !== accessCollectionKey(selected.through) ||
        link.through.collectionName !== selected.through.collectionName
      )
        invalid('Creation association identities must remain the same between rows');
      const { relation } = selected;
      const keys = link.keys.length ? normalizeKeys(link.keys, relation.target) : [];
      return { link, relation, keys };
    });
  });
  const entries = [...relations.entries()];
  const metadata = entries.length
    ? accessMetadataGuard(
        db,
        entries.flatMap(([, { target, relation }]) => [
          { model: relation.sourceModel, config: relation.sourceConfig },
          { model: relation.targetModel, config: prepared.configuration(ctx, target)! },
        ]),
        entries.map(([name, { relation }]) => ({ model: relation.sourceModel, path: [name] })),
      )
    : () => {};
  const current = () => {
    for (const [, { relation }] of entries) relation.current();
    metadata();
  };
  const read = async (
    relation: ReturnType<typeof resolveManyToMany>,
    sourceKeys: readonly string[],
    transaction: Transaction,
    limit: number,
  ) => {
    const rows = await relation.throughModel.unscoped().findAll(
      internalQuery({
        where: { [relation.foreignKey]: { [Op.in]: sourceKeys } },
        transaction,
        lock: transaction.LOCK.UPDATE,
        limit,
      }),
    );
    current();
    return rows;
  };
  const groups: Array<{
    relation: ReturnType<typeof resolveManyToMany>;
    target: AccessCollectionIdentity;
    where: AccessCreationLink['where'];
    keys: Set<string>;
  }> = [];
  for (const row of plans)
    for (const { link, relation, keys } of row) {
      if (!keys.length) continue;
      let group = groups.find((entry) => entry.relation === relation && isDeepStrictEqual(entry.where, link.where));
      if (!group) {
        group = { relation, target: link.target, where: link.where, keys: new Set() };
        groups.push(group);
      }
      for (const key of keys) group.keys.add(key);
    }
  const checkSources = (sourceKeys: readonly string[]) => {
    if (sourceKeys.length !== plans.length) invalid('Every created row requires its own connection binding');
  };
  current();
  return {
    batched,
    count: plans.reduce((sum, row) => sum + row.length, 0),
    rowCounts: plans.map((row) => row.length),
    current,
    async authorize(authenticated: AccessIdentity, transaction: Transaction) {
      for (const { target, relation, keys, where } of groups) {
        const selected = [...keys];
        for (let offset = 0; offset < selected.length; offset += 1000) {
          await new AccessReferenceService(db, prepared, queries).authorizeTargets(
            ctx,
            target,
            authenticated,
            { keys: selected.slice(offset, offset + 1000), where: { [Op.and]: [relation.scope ?? {}, where ?? {}] } },
            transaction,
          );
          current();
        }
      }
    },
    async persist(sourceKeys: readonly string[], transaction: Transaction, assertCurrent: () => void) {
      checkSources(sourceKeys);
      for (const [, { relation }] of entries) {
        if ((await read(relation, sourceKeys, transaction, 1)).length)
          invalid('Creation writer added unplanned connections');
        assertCurrent();
      }
      for (let index = 0; index < plans.length; index++)
        for (const plan of plans[index]) {
          const sourceKey = sourceKeys[index];
          const { link, relation, keys } = plan;
          if (!keys.length) continue;
          const repository = relation.source.repository
            .relation<BelongsToManyRepository>(link.association)
            .of(sourceKey);
          const options = { tk: keys, transaction, context: ctx };
          await guardJoinWrite(
            db,
            relation.source,
            relation.target,
            relation.through,
            relation.foreignKey,
            relation.otherKey,
            transaction,
            { operation: 'add', sourceKey, targetKeys: keys },
            assertCurrent,
            () => repository.add(options),
          );
          assertCurrent();
        }
    },
    async verify(sourceKeys: readonly string[], transaction: Transaction) {
      checkSources(sourceKeys);
      for (const [name, { relation }] of entries) {
        const expected = new Map(
          sourceKeys.map((key, index) => [
            key,
            new Set(plans[index].find((plan) => plan.link.association === name)?.keys ?? []),
          ]),
        );
        const total = [...expected.values()].reduce((sum, keys) => sum + keys.size, 0);
        const actual = await read(relation, sourceKeys, transaction, total + 1);
        if (actual.length !== total) invalid('Writer changed unauthorized connections');
        for (const row of actual) {
          const sourceKey = normalizeKeys([row.getDataValue(relation.foreignKey)], relation.source)[0];
          const targetKey = normalizeKeys([row.getDataValue(relation.otherKey)], relation.target)[0];
          if (!expected.get(sourceKey)?.delete(targetKey)) invalid('Writer changed unauthorized connections');
        }
      }
    },
  };
}

export function prepareCreationLinks(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  ctx: object,
  source: AccessCollectionIdentity,
  links: AccessCreationLink[],
  original: AccessCreationLink[],
  limit: number,
) {
  return prepareRows(db, prepared, queries, ctx, source, [links], [original], limit, false);
}

export function prepareCreationLinkRows(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  ctx: object,
  source: AccessCollectionIdentity,
  rows: AccessCreationLink[][],
  original: AccessCreationLink[][],
  limit: number,
) {
  return prepareRows(db, prepared, queries, ctx, source, rows, original, limit, true);
}
