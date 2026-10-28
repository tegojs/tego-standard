import { Op, type Collection, type Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { captureAssociationLinkInput, captureAssociationSourcePermission } from './association-link-input';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission, type AccessFinalActionPermission } from './final-action-permission';
import { AccessHasManyService } from './has-many';
import { AccessHasOneService } from './has-one';
import { accessMetadataGuard } from './metadata-snapshot';
import { AccessMutationService } from './mutation';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter } from './read-grants';
import { AccessReferenceService } from './references';
import { prepareRelationalMutationFilter } from './relational-mutation-filter';
import { AccessRoleFilterCompiler } from './role-filter';
import { captureRelatedReadPermission, type AccessRootReadContext } from './root-read-context';
import { prepareScalarMutationFilter } from './scalar-mutation-filter';
import { resolveTargetForeignKey } from './target-foreign-key-metadata';
import { cloneDeep, invalid, normalizeKeys, plain, validateRootValues } from './write-support';

function data(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Child mutation input cannot contain accessors');
  return descriptor.value;
}

/** Internal concrete foreign-key association actions with independent child write decisions. */
export class AccessTargetForeignKeyMutationHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
    private readonly associationType: 'HasMany' | 'HasOne' = 'HasMany',
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
    const input = captureAssociationLinkInput(this.db, ctx, authenticated, this.associationType);
    return this.execute(ctx, input, authorizeUpdate, authorizeRead, authorizeSource);
  }

  /** Root form update of ordinary fields and one target-FK selection. Does not register routes. */
  async handleRoot(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorizeUpdate: (collection: Collection) => Promise<AccessRootReadContext | null>,
    authorizeRead: (collection: Collection) => Promise<AccessRootReadContext | null>,
  ): Promise<void> {
    if (ctx.db !== this.db || !ctx.action || typeof ctx.action !== 'object' || !plain(authenticated))
      invalid('Root child mutation context is unavailable');
    const resourceName = data(ctx.action, 'resourceName');
    if (
      typeof resourceName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(resourceName) ||
      ['_', '__proto__', 'constructor', 'prototype'].includes(resourceName) ||
      data(ctx.action, 'actionName') !== 'update' ||
      data(ctx.action, 'sourceId') !== undefined ||
      data(ctx.action, 'resourceOf') !== undefined
    )
      invalid('Root child mutations require a root update');
    const actor = Object.freeze(cloneDeep(authenticated));
    if (typeof actor.roleName !== 'string') invalid('Root child mutations require an authenticated role');
    const permission = captureFinalActionPermission(ctx.permission, {
      resourceName,
      actionName: 'update',
      roleName: actor.roleName,
    });
    if (!permission.allowed || !plain(ctx.permission)) invalid('Root child update is not authorized');
    const raw = data(ctx.permission, 'rawParams');
    const allowed = [
      'resourceName',
      'actionName',
      'associatedName',
      'associatedIndex',
      'resourceIndex',
      'filterByTk',
      'values',
      'filter',
    ];
    if (!plain(raw) || Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !allowed.includes(key)))
      invalid('Unsupported root child parameters');
    for (const key of Reflect.ownKeys(raw)) data(raw, key);
    const rawFilter = data(raw, 'filter');
    const requestFilter = rawFilter === undefined ? {} : captureAccessFilter(rawFilter);
    if (!plain(requestFilter)) invalid('Mutation request filters must be plain objects');
    const submitted = data(raw, 'values');
    if (!plain(submitted)) invalid('Root child update requires named values');
    for (const key of Reflect.ownKeys(submitted)) {
      if (typeof key !== 'string') invalid('Root child values require field names');
      data(submitted, key);
    }
    const params = cloneDeep(raw);
    for (const [key, expected] of [
      ['resourceName', resourceName],
      ['actionName', 'update'],
      ['associatedName', undefined],
      ['associatedIndex', undefined],
    ] as const)
      if (Object.hasOwn(params, key) && params[key] !== expected)
        invalid('Root child transport metadata does not match');
    const source = this.db.getCollection(resourceName);
    const sourceKey = params.filterByTk;
    if (
      !source ||
      !(
        (typeof sourceKey === 'string' && sourceKey.length > 0 && sourceKey.length <= 255) ||
        (typeof sourceKey === 'number' && Number.isSafeInteger(sourceKey))
      ) ||
      (params.resourceIndex !== undefined &&
        (!['string', 'number'].includes(typeof params.resourceIndex) ||
          String(params.resourceIndex) !== String(sourceKey)))
    )
      invalid('Root child update requires one matching source key');
    const values = params.values as Record<string, unknown>;
    const names = Object.keys(values).filter((key) => Object.hasOwn(source.model.associations, key));
    if (names.length !== 1 || source.model.associations[names[0]].associationType !== this.associationType)
      invalid('Root child update requires one registered target foreign-key selection');
    const name = names[0];
    const value = values[name];
    const original = data(submitted, name);
    if (this.associationType === 'HasMany') {
      if (
        !Array.isArray(original) ||
        Object.getPrototypeOf(original) !== Array.prototype ||
        original.length > 1000 ||
        Reflect.ownKeys(original).length !== original.length + 1 ||
        Array.from({ length: original.length }, (_, index) => index).some((index) => !Object.hasOwn(original, index))
      )
        invalid('Root children require a bounded dense key array');
      for (let index = 0; index < original.length; index++) data(original, String(index));
    } else if (value !== null && typeof value !== 'string' && typeof value !== 'number')
      invalid('Root HasOne selection requires one key or null');
    return this.execute(
      ctx,
      {
        actor,
        name,
        resourceName,
        operation: 'set',
        sourceKey,
        requestFilter,
        value:
          this.associationType === 'HasMany'
            ? (value as Array<string | number>)
            : value === null
              ? []
              : [value as string | number],
        sourceValues: Object.fromEntries(Object.entries(values).filter(([key]) => key !== name)),
      },
      authorizeUpdate,
      authorizeRead,
      undefined,
      permission,
    );
  }

  private async execute(
    ctx: AccessRootReadContext,
    input: {
      actor: AccessIdentity;
      name: string;
      resourceName: string;
      targetName?: string;
      operation: 'add' | 'remove' | 'set';
      sourceKey: string | number;
      requestFilter?: Record<PropertyKey, unknown>;
      value: Array<string | number>;
      permission?: Readonly<AccessFinalActionPermission>;
      sourceValues?: Record<string, unknown>;
    },
    authorizeUpdate: (collection: Collection) => Promise<AccessRootReadContext | null>,
    authorizeRead: (collection: Collection) => Promise<AccessRootReadContext | null>,
    authorizeSource?: (
      collection: Collection,
      operation: 'add' | 'remove' | 'set',
    ) => Promise<AccessRootReadContext | null>,
    rootPermission?: Readonly<AccessFinalActionPermission>,
  ): Promise<void> {
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
      (input.targetName !== undefined && target.name !== input.targetName) ||
      association.associationType !== this.associationType
    )
      invalid('Child mutations require a registered foreign-key association field');
    const entryMetadata = accessMetadataGuard(this.db, [], [{ model: source.model, path: [name] }]);
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
      this.associationType,
    );
    if (rootPermission && Object.keys(input.sourceValues!).length)
      validateRootValues(this.db, input.sourceValues, source, 'update', relation.sourceConfig.ownership.enabled);
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
    entryMetadata();
    const metadata = accessMetadataGuard(
      this.db,
      [
        { model: source.model, config: relation.sourceConfig },
        { model: target.model, config: relation.targetConfig },
      ],
      [{ model: source.model, path: [name] }, ...aliases.map((alias) => ({ model: target.model, path: [alias] }))],
    );
    const compiler = new AccessRoleFilterCompiler(this.db, this.resolveIdentity);
    const relational =
      rootPermission && Reflect.ownKeys(input.requestFilter ?? {}).length
        ? prepareRelationalMutationFilter(
            this.db,
            this.prepared,
            this.queries,
            ctx,
            source,
            sourceIdentity,
            actor,
            input.requestFilter!,
            this.resolveIdentity,
          )
        : undefined;
    const selection = relational
      ? undefined
      : prepareScalarMutationFilter(
          this.db,
          source,
          sourceIdentity,
          relation.sourceConfig,
          input.requestFilter ?? {},
          roleName,
          compiler,
          this.resolveIdentity,
        );
    const roles: Array<ReturnType<AccessRoleFilterCompiler['compile']>> = [];
    let assertReadCurrent: (() => void) | undefined;
    const current = () => {
      relation.current();
      metadata();
      roles.forEach((role) => role.assertCurrent());
      selection?.assertCurrent();
      relational?.assertCurrent();
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
    // Retain the finalized target decision before awaiting independent source authorization.
    const targetWhere = rootPermission
      ? undefined
      : compile(input.permission!, target, [target.model.primaryKeyAttribute], true);
    current();
    const related = rootPermission ? undefined : await authorizeSource!(source, operation);
    current();
    const sourcePermission =
      rootPermission ?? captureAssociationSourcePermission(this.db, source, roleName, operation, related);
    const sourceRoleWhere = compile(sourcePermission, source, [name], !rootPermission);
    let sourceValues: Record<string, unknown> | undefined;
    if (rootPermission) {
      const grants = sourcePermission.params as { whitelist?: string[]; blacklist?: string[] };
      sourceValues = Object.fromEntries(
        Object.entries(input.sourceValues!).filter(
          ([field]) =>
            ((grants.whitelist === undefined || grants.whitelist.includes(field)) &&
              !grants.blacklist?.includes(field)) ||
            (relation.sourceConfig.ownership.enabled && field === 'tenantId'),
        ),
      );
    }
    current();
    const requested = selection ? await selection.resolve(authorizeRead, current) : undefined;
    const sourceScope = relational ? await relational.resolve(authorizeRead, current) : undefined;
    const sourceWhere = requested ? { [Op.and]: [sourceRoleWhere, requested] } : sourceRoleWhere;
    const entry = {
      assertCurrent: current,
      ...(sourceScope ? { sourceScope } : {}),
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
    };
    const mutations = new AccessMutationService(this.db, this.prepared, this.queries);
    const references = new AccessReferenceService(this.db, this.prepared, this.queries);
    const result =
      this.associationType === 'HasOne'
        ? operation === 'remove'
          ? await new AccessHasOneService(this.db, this.prepared, this.queries, mutations, references).removeTarget(
              ctx,
              sourceIdentity,
              targetIdentity,
              actor,
              { association: name, sourceKey, sourceWhere, targetWhere, sourceValues },
              entry,
            )
          : await new AccessHasOneService(this.db, this.prepared, this.queries, mutations, references).withTarget(
              ctx,
              sourceIdentity,
              targetIdentity,
              actor,
              {
                association: name,
                sourceKey,
                targetKey: targetKeys[0] ?? null,
                sourceWhere,
                targetWhere,
                sourceValues,
              },
              entry,
            )
        : await new AccessHasManyService(this.db, this.prepared, this.queries, mutations, references).withChildren(
            ctx,
            sourceIdentity,
            targetIdentity,
            actor,
            { association: name, operation, sourceKey, targetKeys, sourceWhere, targetWhere, sourceValues },
            entry,
          );
    current();
    ctx.body = rootPermission ? result.sourceResult : result;
  }
}

/** Backward-compatible name for the default HasMany handler. */
export { AccessTargetForeignKeyMutationHandler as AccessHasManyMutationHandler };
