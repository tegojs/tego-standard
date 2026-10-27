import { isDeepStrictEqual } from 'node:util';
import { Op, type Database, type Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import type { AccessCreationReference, AccessCreationRequest } from './creation';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { AccessReferenceService } from './references';
import { cloneDeep, invalid, normalizeKeys, plain } from './write-support';

function dense(input: unknown, limit: number): asserts input is unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > limit ||
    Reflect.ownKeys(input).length !== input.length + 1 ||
    Array.from({ length: input.length }, (_, index) => index).some((index) => !Object.hasOwn(input, index))
  )
    invalid('Creation references require bounded dense lists');
}

/** Inputs have already been detached by creation; inspect original matrix prototypes before using the clone. */
export function prepareCreationReferenceRows(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  ctx: object,
  source: AccessCollectionIdentity,
  request: AccessCreationRequest,
  original: AccessCreationRequest,
  limit: number,
) {
  const batched = request.rowReferences !== undefined;
  if (batched && [request.reference, request.references, request.links].some((value) => value !== undefined))
    invalid('Per-row references cannot be combined with single-record references or links');
  if (request.reference !== undefined && request.references !== undefined)
    invalid('Supply either a single reference or a reference list');
  if (batched) {
    dense(original.rowReferences, 1000);
    for (const row of original.rowReferences) dense(row, limit);
    if (request.rowReferences.length !== request.values.length)
      invalid('Every created row requires its own reference selection');
  }
  const references =
    request.references === undefined
      ? request.reference === undefined
        ? []
        : [request.reference]
      : request.references;
  const inputRows = batched ? request.rowReferences : [references];
  const relations = new Map<
    string,
    { target: AccessCollectionIdentity; relation: ReturnType<typeof resolveBelongsTo> }
  >();
  const rows = inputRows.map((references) => {
    dense(references, limit);
    const names = new Set<string>();
    return references.map((input) => {
      const reference = input as AccessCreationReference;
      if (!plain(reference) || typeof reference.association !== 'string' || names.has(reference.association))
        invalid('Creation references must have distinct registered association names');
      names.add(reference.association);
      let selected = relations.get(reference.association);
      if (!selected) {
        const relation = resolveBelongsTo(
          db,
          prepared,
          queries,
          ctx,
          source,
          reference.target,
          reference.association,
          true,
        );
        selected = { target: cloneDeep(reference.target), relation };
        relations.set(reference.association, selected);
      } else if (
        !plain(reference.target) ||
        reference.target.dataSourceKey !== selected.target.dataSourceKey ||
        reference.target.collectionKey !== selected.target.collectionKey ||
        reference.target.collectionName !== selected.target.collectionName
      )
        invalid('The same creation association cannot select different target identities');
      const key = reference.key === null ? null : normalizeKeys([reference.key], selected.relation.target)[0];
      return { reference, relation: selected.relation, key };
    });
  });
  const entries = [...relations.entries()];
  const metadata =
    entries.length &&
    accessMetadataGuard(
      db,
      [
        { model: entries[0][1].relation.sourceModel, config: entries[0][1].relation.sourceConfig },
        ...entries.map(([, { relation }]) => ({ model: relation.targetModel, config: relation.targetConfig })),
      ],
      entries.map(([name, { relation }]) => ({ model: relation.sourceModel, path: [name] })),
    );
  const assertCurrent = () => {
    for (const [, { relation }] of entries) relation.current();
    if (metadata) metadata();
  };
  const groups: Array<{
    relation: ReturnType<typeof resolveBelongsTo>;
    target: AccessCollectionIdentity;
    where: AccessCreationReference['where'];
    keys: Set<string>;
  }> = [];
  for (const plans of rows)
    for (const plan of plans) {
      if (plan.key === null) continue;
      let group = groups.find(
        (group) => group.relation === plan.relation && isDeepStrictEqual(group.where, plan.reference.where),
      );
      if (!group) {
        group = {
          relation: plan.relation,
          target: plan.reference.target,
          where: plan.reference.where,
          keys: new Set(),
        };
        groups.push(group);
      }
      group.keys.add(plan.key);
    }
  const forRow = (index: number) => rows[batched ? index : 0];
  return {
    batched,
    count: rows.reduce((count, row) => count + row.length, 0),
    singleRowCount: rows[0]?.length ?? 0,
    names: new Set(relations.keys()),
    forRow,
    assertCurrent,
    expectedForRow: (index: number) => new Map(forRow(index).map((plan) => [plan.relation.foreignKey, plan])),
    async authorize(authenticated: AccessIdentity, transaction: Transaction, current: () => void) {
      const references = new AccessReferenceService(db, prepared, queries);
      for (const group of groups) {
        await references.authorizeTargets(
          ctx,
          group.target,
          authenticated,
          {
            keys: [...group.keys],
            where: { [Op.and]: [group.relation.scope ?? {}, group.where ?? {}] },
          },
          transaction,
        );
        current();
      }
    },
  };
}
