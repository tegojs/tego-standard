import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { captureAssociationLinkInput, captureAssociationSourcePermission } from './association-link-input';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureAccessFilter } from './filter-input';
import type { AccessFinalActionPermission } from './final-action-permission';
import { AccessHasManyService } from './has-many';
import { accessMetadataGuard } from './metadata-snapshot';
import { AccessMutationService } from './mutation';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter } from './read-grants';
import { AccessReferenceService } from './references';
import { AccessRoleFilterCompiler } from './role-filter';
import { captureRelatedReadPermission, type AccessRootReadContext } from './root-read-context';
import { resolveTargetForeignKey } from './target-foreign-key-metadata';
import { cloneDeep, invalid, normalizeKeys, plain } from './write-support';

/** Internal concrete HasMany actions; child edits require their own final update decision. */
export class AccessHasManyMutationHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  async handle(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorizeSource: (
      collection: Collection,
      operation: 'add' | 'remove' | 'set',
    ) => Promise<AccessRootReadContext | null>,
    authorizeUpdate: (collection: Collection) => Promise<AccessRootReadContext | null>,
    authorizeRead: (collection: Collection) => Promise<AccessRootReadContext | null>,
  ): Promise<void> {
    const input = captureAssociationLinkInput(this.db, ctx, authenticated);
    const { actor, name, operation } = input;
    const roleName = actor.roleName;
    if (typeof roleName !== 'string') invalid('Child mutations require an authenticated role');
    const source = this.db.getCollection(input.resourceName);
    const field = source?.getField(name);
    const association = source?.model.associations[name];
    const target = association && this.db.modelCollection.get(association.target);
    if (
      !source ||
      !field ||
      !target ||
      field.target !== target.name ||
      target.name !== input.targetName ||
      association.associationType !== 'HasMany'
    )
      invalid('Child mutations require a registered HasMany field');
    const sourceIdentity = cloneDeep(this.resolveIdentity(source));
    const targetIdentity = cloneDeep(this.resolveIdentity(target));
    if (
      !sourceIdentity ||
      !targetIdentity ||
      sourceIdentity.collectionName !== source.name ||
      targetIdentity.collectionName !== target.name
    )
      invalid('Child mutation collection identity is unavailable');
    const relation = resolveTargetForeignKey(
      this.db,
      this.prepared,
      this.queries,
      ctx,
      sourceIdentity,
      targetIdentity,
      name,
      'HasMany',
    );
    const inverseNames = () =>
      Object.entries(target.model.associations)
        .filter(([, entry]) => {
          const inverse = entry as typeof entry & { foreignKey?: string; targetKey?: string };
          return (
            inverse.associationType === 'BelongsTo' &&
            inverse.target === source.model &&
            inverse.foreignKey === relation.foreignKey &&
            inverse.targetKey === source.model.primaryKeyAttribute
          );
        })
        .map(([alias]) => alias)
        .sort();
    const aliases = inverseNames();
    const inverseFields = aliases.map((alias) => target.getField(alias));
    if (inverseFields.some((entry) => !entry || entry.target !== source.name))
      invalid('Child inverse field is unavailable');
    const metadata = accessMetadataGuard(
      this.db,
      [
        { model: source.model, config: relation.sourceConfig },
        { model: target.model, config: relation.targetConfig },
      ],
      [{ model: source.model, path: [name] }, ...aliases.map((alias) => ({ model: target.model, path: [alias] }))],
    );
    const compiler = new AccessRoleFilterCompiler(this.db, this.resolveIdentity);
    const roles: Array<ReturnType<AccessRoleFilterCompiler['compile']>> = [];
    let assertReadCurrent: (() => void) | undefined;
    const current = () => {
      relation.current();
      metadata();
      roles.forEach((role) => role.assertCurrent());
      assertReadCurrent?.();
      if (
        source.getField(name) !== field ||
        field.target !== target.name ||
        source.filterTargetKey !== source.model.primaryKeyAttribute ||
        target.filterTargetKey !== target.model.primaryKeyAttribute ||
        inverseNames().join('\0') !== aliases.join('\0') ||
        aliases.some(
          (alias, index) =>
            target.getField(alias) !== inverseFields[index] || inverseFields[index]?.target !== source.name,
        )
      )
        invalid('Child mutation fields or locators changed');
      for (const [collection, expected] of [
        [source, sourceIdentity],
        [target, targetIdentity],
      ] as const) {
        const actual = this.resolveIdentity(collection);
        if (
          !actual ||
          actual.collectionName !== expected.collectionName ||
          accessCollectionKey(actual) !== accessCollectionKey(expected)
        )
          invalid('Child mutation identity changed');
      }
    };
    const compile = (
      permission: Readonly<AccessFinalActionPermission>,
      collection: Collection,
      required: string[],
      allowFields: boolean,
    ) => {
      const params = permission.params;
      const allowed = ['whitelist', 'blacklist', 'filter', 'own', ...(allowFields ? ['fields'] : [])];
      if (
        !permission.allowed ||
        !plain(params) ||
        Reflect.ownKeys(params).some((key) => typeof key !== 'string' || !allowed.includes(key))
      )
        invalid('Unsupported child mutation permission');
      const captured: Record<string, unknown> = Object.create(null);
      for (const key of Reflect.ownKeys(params)) {
        const descriptor = Object.getOwnPropertyDescriptor(params, key)!;
        if (!Object.hasOwn(descriptor, 'value')) invalid('Child mutation permission cannot contain accessors');
        if (descriptor.value !== undefined)
          captured[key as string] = key === 'filter' ? captureAccessFilter(descriptor.value) : descriptor.value;
      }
      if (captured.own !== undefined && captured.own !== false) invalid('Own-record permissions must be finalized');
      for (const kind of ['fields', 'whitelist', 'blacklist']) {
        const rawFields = captured[kind];
        if (rawFields === undefined) continue;
        const fields = captureAccessFilter(rawFields);
        if (
          !Array.isArray(fields) ||
          fields.some((entry) => typeof entry !== 'string') ||
          new Set(fields).size !== fields.length
        )
          invalid('Child field grants require distinct field names');
        for (const entry of fields)
          if (
            !Object.hasOwn(collection.model.rawAttributes, entry) &&
            !Object.hasOwn(collection.model.associations, entry)
          )
            invalid('Child permission contains unsupported fields');
        if (
          kind === 'blacklist'
            ? required.some((entry) => fields.includes(entry))
            : !required.some((entry) => fields.includes(entry))
        )
          invalid('Child mutation field is not authorized');
      }
      const role = compiler.compile(collection === source ? sourceIdentity : targetIdentity, captured.filter ?? {});
      roles.push(role);
      return role.rootWhere ?? role.where;
    };
    current();
    const sourceKey = normalizeKeys([input.sourceKey], source)[0];
    const targetKeys = input.value.length ? normalizeKeys(input.value, target) : [];
    const related = await authorizeSource(source, operation);
    current();
    const sourcePermission = captureAssociationSourcePermission(this.db, source, roleName, operation, related);
    const sourceWhere = compile(sourcePermission, source, [name], true);
    const targetWhere = compile(input.permission, target, [target.model.primaryKeyAttribute], true);
    current();
    const result = await new AccessHasManyService(
      this.db,
      this.prepared,
      this.queries,
      new AccessMutationService(this.db, this.prepared, this.queries),
      new AccessReferenceService(this.db, this.prepared, this.queries),
    ).withChildren(
      ctx,
      sourceIdentity,
      targetIdentity,
      actor,
      { association: name, operation, sourceKey, targetKeys, sourceWhere, targetWhere },
      {
        assertCurrent: current,
        targetReadScope: async () => {
          current();
          const related = await authorizeRead(target);
          current();
          if (!related) invalid('Child reference read is not authorized');
          const decision = captureRelatedReadPermission(this.db, target, roleName, related);
          const plan = new AccessReadGrantAdapter(this.db, (collection) => {
            const resolved = this.resolveIdentity(collection);
            return resolved && accessCollectionKey(resolved);
          }).capturePlan(targetIdentity, decision, compiler);
          if (!plan || !plan.grant.fields.includes(target.model.primaryKeyAttribute))
            invalid('Child reference key is not readable');
          assertReadCurrent = plan.assertCurrent;
          current();
          return { where: plan.grant.where };
        },
        targetWriteScope: async () => {
          current();
          const related = await authorizeUpdate(target);
          current();
          const permission = captureAssociationSourcePermission(this.db, target, roleName, 'update', related);
          const where = compile(permission, target, [relation.foreignKey, ...aliases], false);
          current();
          return { where };
        },
      },
    );
    current();
    ctx.body = result;
  }
}
