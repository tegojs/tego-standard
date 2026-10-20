import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { MAX_CREATION_REFERENCES, type AccessCreationReference } from './creation';
import { assertCreationKeyArray, type AccessCreationLink } from './creation-links';
import type { AccessFinalActionPermission } from './final-action-permission';
import { resolveManyToMany } from './many-to-many-metadata';
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
  if (names.length > MAX_CREATION_REFERENCES) invalid('Creation supports at most 20 references');
  const selected = names.map((name) => ({ name, type: collection.model.associations[name].associationType }));
  if (selected.some(({ type }) => !['BelongsTo', 'BelongsToMany'].includes(type)))
    invalid('Creation supports BelongsTo and BelongsToMany references');
  // Prepare every path before awaiting any target decision, including paths whose value is null.
  const references = selected.map(({ name, type }) => {
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
    const multiple = type === 'BelongsToMany';
    const throughModel = (association as unknown as { through?: { model?: Collection['model'] } }).through?.model;
    const through = throughModel && db.modelCollection.get(throughModel);
    const throughIdentity = multiple && through ? cloneDeep(resolveIdentity(through)) : undefined;
    if (multiple && (!through || !throughIdentity || throughIdentity.collectionName !== through.name))
      invalid('Creation link identity is unavailable');
    const relation = multiple
      ? resolveManyToMany(db, prepared, queries, ctx, source, targetIdentity, throughIdentity!, name)
      : resolveBelongsTo(db, prepared, queries, ctx, source, targetIdentity, name, true);
    const key = values[name];
    if (!multiple && key !== null && typeof key !== 'string' && typeof key !== 'number')
      invalid('Creation references require a target key or null');
    if (multiple) assertCreationKeyArray(key);
    const keys = multiple
      ? (key as Array<string | number>).length
        ? normalizeKeys(key, target)
        : []
      : key === null
        ? []
        : normalizeKeys([key], target);
    const { whitelist, blacklist } = permission.params as { whitelist?: string[]; blacklist?: string[] };
    if (
      (whitelist !== undefined && !whitelist.includes(name)) ||
      blacklist?.includes(name) ||
      (!multiple && blacklist?.includes(relation.foreignKey))
    )
      invalid('Creation reference field is not authorized');
    delete values[name];
    const metadata = accessMetadataGuard(
      db,
      [
        { model: relation.sourceModel, config: relation.sourceConfig },
        { model: relation.targetModel, config: prepared.configuration(ctx, targetIdentity)! },
      ],
      [{ model: relation.sourceModel, path: [name] }],
    );
    let assertTargetCurrent: (() => void) | undefined;
    const assertCurrent = () => {
      relation.current();
      metadata();
      assertTargetCurrent?.();
      const actual = resolveIdentity(target);
      const actualThrough = multiple && through ? resolveIdentity(through) : undefined;
      if (
        !actual ||
        actual.collectionName !== target.name ||
        accessCollectionKey(actual) !== accessCollectionKey(targetIdentity) ||
        collection.getField(name) !== field ||
        field.target !== target.name ||
        collection.model.associations[name]?.associationType !== type ||
        (multiple &&
          (!actualThrough ||
            actualThrough.collectionName !== through!.name ||
            accessCollectionKey(actualThrough) !== accessCollectionKey(throughIdentity!)))
      )
        invalid('Creation reference entry identity changed');
    };
    assertCurrent();
    return {
      assertCurrent,
      async resolve(): Promise<{ reference?: AccessCreationReference; link?: AccessCreationLink }> {
        assertCurrent();
        const result = (where?: AccessCreationReference['where']) =>
          multiple
            ? { link: { association: name, target: targetIdentity, through: throughIdentity!, keys, where } }
            : { reference: { association: name, target: targetIdentity, key: keys[0] ?? null, where } };
        if (!keys.length) return result();
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
        return result(plan.grant.where);
      },
    };
  });
  const assertCurrent = () => references.forEach((reference) => reference.assertCurrent());
  assertCurrent();
  return {
    names,
    values,
    assertCurrent,
    async resolve(): Promise<{ references: AccessCreationReference[]; links: AccessCreationLink[] }> {
      const result: { references: AccessCreationReference[]; links: AccessCreationLink[] } = {
        references: [],
        links: [],
      };
      for (const reference of references) {
        assertCurrent();
        const resolved = await reference.resolve();
        if (resolved.reference) result.references.push(resolved.reference);
        if (resolved.link) result.links.push(resolved.link);
        assertCurrent();
      }
      return result;
    },
  };
}
