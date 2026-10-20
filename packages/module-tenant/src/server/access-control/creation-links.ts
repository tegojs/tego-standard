import { Op, type BelongsToManyRepository, type Database, type Transaction, type WhereOptions } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { guardJoinWrite } from './join-write-guard';
import { resolveManyToMany } from './many-to-many-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { AccessReferenceService } from './references';
import { internalQuery, invalid, normalizeKeys, plain } from './write-support';

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

/** Pure joins only. The caller owns the new source INSERT, transaction and final source checks. */
export function prepareCreationLinks(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  ctx: object,
  source: AccessCollectionIdentity,
  links: AccessCreationLink[],
  original: AccessCreationLink[],
) {
  const joins = new Set<object>();
  const plans = links.map((link, index) => {
    if (
      !plain(link) ||
      typeof link.association !== 'string' ||
      Reflect.ownKeys(link).some(
        (key) => typeof key !== 'string' || !['association', 'target', 'through', 'keys', 'where'].includes(key),
      )
    )
      invalid('Creation links require registered association names');
    assertCreationKeyArray(original[index].keys);
    assertCreationKeyArray(link.keys);
    const relation = resolveManyToMany(db, prepared, queries, ctx, source, link.target, link.through, link.association);
    if (joins.has(relation.throughModel)) invalid('Creation links cannot use overlapping join tables');
    joins.add(relation.throughModel);
    const keys = link.keys.length ? normalizeKeys(link.keys, relation.target) : [];
    return { link, relation, keys };
  });
  const metadata = accessMetadataGuard(
    db,
    plans.flatMap(({ link, relation }) => [
      { model: relation.sourceModel, config: relation.sourceConfig },
      { model: relation.targetModel, config: prepared.configuration(ctx, link.target)! },
    ]),
    plans.map(({ link, relation }) => ({ model: relation.sourceModel, path: [link.association] })),
  );
  const current = () => {
    for (const { relation } of plans) relation.current();
    metadata();
  };
  const read = async (plan: (typeof plans)[number], sourceKey: string, transaction: Transaction) => {
    const { relation } = plan;
    const rows = await relation.throughModel.unscoped().findAll(
      internalQuery({
        where: { [relation.foreignKey]: sourceKey },
        transaction,
        lock: transaction.LOCK.UPDATE,
        limit: 1001,
      }),
    );
    current();
    if (rows.length > 1000) invalid('Creation links exceed batch limit');
    const keys = rows.map((row) => normalizeKeys([row.getDataValue(relation.otherKey)], relation.target)[0]);
    if (new Set(keys).size !== keys.length) invalid('Creation links contain duplicate connections');
    return new Set(keys);
  };
  current();
  return {
    current,
    async authorize(authenticated: AccessIdentity, transaction: Transaction) {
      for (const { link, relation, keys } of plans) {
        if (keys.length)
          await new AccessReferenceService(db, prepared, queries).authorizeTargets(
            ctx,
            link.target,
            authenticated,
            { keys, where: { [Op.and]: [relation.scope ?? {}, link.where ?? {}] } },
            transaction,
          );
        current();
      }
    },
    async persist(sourceKey: string, transaction: Transaction, assertCurrent: () => void) {
      for (const plan of plans) {
        const { link, relation, keys } = plan;
        if ((await read(plan, sourceKey, transaction)).size) invalid('Creation writer added unplanned connections');
        assertCurrent();
        if (!keys.length) continue;
        const repository = relation.source.repository.relation<BelongsToManyRepository>(link.association).of(sourceKey);
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
    async verify(sourceKey: string, transaction: Transaction) {
      for (const plan of plans) {
        const actual = await read(plan, sourceKey, transaction);
        if (actual.size !== plan.keys.length || plan.keys.some((key) => !actual.has(key)))
          invalid('Writer changed unauthorized connections');
      }
    },
  };
}
