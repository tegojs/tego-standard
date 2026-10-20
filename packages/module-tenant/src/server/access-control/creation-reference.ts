import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { MAX_CREATION_REFERENCES, type AccessCreationReference } from './creation';
import type { AccessFinalActionPermission } from './final-action-permission';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter } from './read-grants';
import { AccessRoleFilterCompiler } from './role-filter';
import { captureRelatedReadPermission, type AccessRootReadContext } from './root-read-context';
import { cloneDeep, invalid, normalizeKeys, plain } from './write-support';

/** A trusted server callback supplies a neutral finalized list context; request params cannot supply it. */
export type AccessCreationTargetAuthorizer = (collection: Collection) => Promise<AccessRootReadContext | null>;

export function prepareCreationReferences(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: AccessRootReadContext,
  source: AccessCollectionIdentity,
  input: unknown,
  permission: Readonly<AccessFinalActionPermission>,
  roleName: string,
  authorize: AccessCreationTargetAuthorizer,
) {
  if (!plain(input)) invalid('Creation requires named field values');
  const values = cloneDeep(input);
  const collection = db.getCollection(source.collectionName);
  const names = Object.keys(values).filter((name) => Object.hasOwn(collection.model.associations, name));
  if (!names.length) return;
  if (names.length > MAX_CREATION_REFERENCES) invalid('Creation supports at most 20 BelongsTo references');
  // Prepare every path before awaiting any target decision, including paths whose value is null.
  const references = names.map((name) => {
    const field = collection.getField(name);
    const association = collection.model.associations[name];
    const target = db.modelCollection.get(association.target);
    const targetIdentity = target && cloneDeep(resolveIdentity(target));
    if (
      !target ||
      !field ||
      field.target !== target.name ||
      !targetIdentity ||
      targetIdentity.collectionName !== target.name
    )
      invalid('Creation reference identity is unavailable');
    const relation = resolveBelongsTo(db, prepared, queries, ctx, source, targetIdentity, name, true);
    const key = values[name];
    if (key !== null && typeof key !== 'string' && typeof key !== 'number')
      invalid('Creation references require a target key or null');
    const targetKey = key === null ? null : normalizeKeys([key], target)[0];
    const { whitelist, blacklist } = permission.params as { whitelist?: string[]; blacklist?: string[] };
    if (
      (whitelist !== undefined && !whitelist.includes(name)) ||
      blacklist?.includes(name) ||
      blacklist?.includes(relation.foreignKey)
    )
      invalid('Creation reference field is not authorized');
    delete values[name];
    const metadata = accessMetadataGuard(
      db,
      [
        { model: relation.sourceModel, config: relation.sourceConfig },
        { model: relation.targetModel, config: relation.targetConfig },
      ],
      [{ model: relation.sourceModel, path: [name] }],
    );
    let assertTargetCurrent: (() => void) | undefined;
    const assertCurrent = () => {
      relation.current();
      metadata();
      assertTargetCurrent?.();
      const actual = resolveIdentity(target);
      if (
        !actual ||
        actual.collectionName !== target.name ||
        accessCollectionKey(actual) !== accessCollectionKey(targetIdentity) ||
        collection.getField(name) !== field ||
        field.target !== target.name
      )
        invalid('Creation reference entry identity changed');
    };
    assertCurrent();
    return {
      assertCurrent,
      async resolve(): Promise<AccessCreationReference> {
        assertCurrent();
        if (targetKey === null) return { association: name, target: targetIdentity, key: null };
        const related = await authorize(target);
        assertCurrent();
        if (!related) invalid('Creation reference target is not authorized');
        const decision = captureRelatedReadPermission(db, target, roleName, related);
        const compiler = new AccessRoleFilterCompiler(db, resolveIdentity);
        const plan = new AccessReadGrantAdapter(db, (collection) => {
          const identity = resolveIdentity(collection);
          return identity && accessCollectionKey(identity);
        }).capturePlan(targetIdentity, decision, compiler);
        if (!plan || !plan.grant.fields.includes(target.model.primaryKeyAttribute))
          invalid('Creation reference target key is not readable');
        assertTargetCurrent = plan.assertCurrent;
        assertCurrent();
        return { association: name, target: targetIdentity, key: targetKey, where: plan.grant.where };
      },
    };
  });
  const assertCurrent = () => references.forEach((reference) => reference.assertCurrent());
  assertCurrent();
  return {
    names,
    values,
    assertCurrent,
    async resolve(): Promise<AccessCreationReference[]> {
      const result: AccessCreationReference[] = [];
      for (const reference of references) {
        assertCurrent();
        result.push(await reference.resolve());
        assertCurrent();
      }
      return result;
    },
  };
}
