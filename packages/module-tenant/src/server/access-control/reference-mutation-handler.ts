import { Op, type Collection, type Database, type Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { captureAssociationLinkInput, captureAssociationSourcePermission } from './association-link-input';
import { resolveBelongsTo } from './association-metadata';
import { AccessBelongsToService } from './belongs-to';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission, type AccessFinalActionPermission } from './final-action-permission';
import { AccessManyToManyService } from './many-to-many';
import { resolveManyToMany } from './many-to-many-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import { AccessMutationService } from './mutation';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter } from './read-grants';
import { AccessReferenceService } from './references';
import { AccessRoleFilterCompiler } from './role-filter';
import { captureRelatedReadPermission, type AccessRootReadContext } from './root-read-context';
import { cloneDeep, internalQuery, invalid, normalizeKeys, plain, unavailable } from './write-support';

function data(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Reference context cannot contain accessors');
  return descriptor.value;
}

function shape(input: unknown, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (!plain(input) || Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key)))
    invalid('Unsupported reference mutation parameters');
  for (const key of Reflect.ownKeys(input)) data(input, key);
}

/** Internal reference mutations; never edit targets or register routes. */
export class AccessReferenceMutationHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  async handle(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorizeTarget: (collection: Collection) => Promise<AccessRootReadContext | null>,
  ): Promise<void> {
    if (ctx.db !== this.db || !ctx.action || typeof ctx.action !== 'object' || !plain(authenticated))
      invalid('Reference database or authenticated context is unavailable');
    const resourceName = data(ctx.action, 'resourceName');
    if (
      typeof resourceName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(resourceName) ||
      ['_', '__proto__', 'constructor', 'prototype'].includes(resourceName) ||
      data(ctx.action, 'actionName') !== 'update' ||
      data(ctx.action, 'sourceId') !== undefined ||
      data(ctx.action, 'resourceOf') !== undefined
    )
      invalid('Only root reference updates are supported');
    const actor = Object.freeze(cloneDeep(authenticated));
    if (typeof actor.roleName !== 'string') invalid('Reference updates require an authenticated role');
    const permission = captureFinalActionPermission(ctx.permission, {
      resourceName,
      actionName: 'update',
      roleName: actor.roleName,
    });
    if (!permission.allowed || !plain(ctx.permission)) invalid('Reference update is not authorized');
    const raw = data(ctx.permission, 'rawParams');
    shape(raw, [
      'resourceName',
      'actionName',
      'associatedName',
      'associatedIndex',
      'resourceIndex',
      'filterByTk',
      'values',
    ]);
    const params = cloneDeep(raw);
    for (const [key, expected] of [
      ['resourceName', resourceName],
      ['actionName', 'update'],
      ['associatedName', undefined],
      ['associatedIndex', undefined],
    ] as const)
      if (Object.hasOwn(params, key) && params[key] !== expected)
        invalid('Reference transport metadata does not match');
    if (
      !(
        (typeof params.filterByTk === 'string' && params.filterByTk.length > 0 && params.filterByTk.length <= 255) ||
        (typeof params.filterByTk === 'number' && Number.isSafeInteger(params.filterByTk))
      ) ||
      (params.resourceIndex !== undefined &&
        (!['string', 'number'].includes(typeof params.resourceIndex) ||
          String(params.resourceIndex) !== String(params.filterByTk)))
    )
      invalid('Reference update requires a single matching source key');
    if (!plain(params.values) || Reflect.ownKeys(params.values).length !== 1)
      invalid('Reference updates require exactly one association');
    const name = Reflect.ownKeys(params.values)[0];
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) invalid('Invalid association name');
    const value = data(params.values, name);
    const rawValues = data(raw, 'values');
    return this.execute(
      ctx,
      actor,
      {
        resourceName,
        name,
        value,
        sourceKey: params.filterByTk,
        originalValue: plain(rawValues) ? data(rawValues, name) : undefined,
      },
      authorizeTarget,
      permission,
    );
  }

  async handleAssociation(
    ctx: AccessRootReadContext,
    authenticated: AccessIdentity,
    authorizeSource: (
      collection: Collection,
      operation: 'add' | 'remove' | 'set',
    ) => Promise<AccessRootReadContext | null>,
    authorizeTarget: (collection: Collection) => Promise<AccessRootReadContext | null>,
  ): Promise<void> {
    const captured = captureAssociationLinkInput(this.db, ctx, authenticated, 'BelongsToMany');
    return this.execute(
      ctx,
      captured.actor,
      captured,
      authorizeTarget,
      undefined,
      authorizeSource,
      captured.permission,
    );
  }

  private async execute(
    ctx: AccessRootReadContext,
    actor: AccessIdentity,
    input: {
      resourceName: string;
      name: string;
      value: unknown;
      sourceKey: string | number;
      originalValue?: unknown;
      operation?: 'add' | 'remove' | 'set';
      targetName?: string;
    },
    authorizeTarget: (collection: Collection) => Promise<AccessRootReadContext | null>,
    sourcePermission?: Readonly<AccessFinalActionPermission>,
    authorizeSource?: (
      collection: Collection,
      operation: 'add' | 'remove' | 'set',
    ) => Promise<AccessRootReadContext | null>,
    targetPermission?: Readonly<AccessFinalActionPermission>,
  ): Promise<void> {
    const { resourceName, name, value } = input;
    const roleName = actor.roleName!;
    const source = this.db.getCollection(resourceName);
    const field = source?.getField(name);
    const association = source?.model.associations[name];
    const target = association && this.db.modelCollection.get(association.target);
    if (
      !source ||
      !field ||
      !target ||
      field.target !== target.name ||
      !['BelongsTo', 'BelongsToMany'].includes(association.associationType) ||
      (input.operation !== undefined &&
        (association.associationType !== 'BelongsToMany' || target.name !== input.targetName))
    )
      invalid('Reference requires a registered reference field');
    const multiple = association.associationType === 'BelongsToMany';
    const sourceIdentity = cloneDeep(this.resolveIdentity(source));
    const targetIdentity = cloneDeep(this.resolveIdentity(target));
    if (
      !sourceIdentity ||
      !targetIdentity ||
      sourceIdentity.collectionName !== source.name ||
      targetIdentity.collectionName !== target.name
    )
      invalid('Reference collection identity is unavailable');
    const throughModel = (association as unknown as { through?: { model?: Collection['model'] } }).through?.model;
    const through = throughModel && this.db.modelCollection.get(throughModel);
    const throughIdentity = multiple && through ? cloneDeep(this.resolveIdentity(through)) : undefined;
    if (multiple && (!through || !throughIdentity || throughIdentity.collectionName !== through.name))
      invalid('Reference join identity is unavailable');
    const relation = multiple
      ? resolveManyToMany(
          this.db,
          this.prepared,
          this.queries,
          ctx,
          sourceIdentity,
          targetIdentity,
          throughIdentity!,
          name,
        )
      : resolveBelongsTo(this.db, this.prepared, this.queries, ctx, sourceIdentity, targetIdentity, name, true);
    const keys = normalizeKeys([input.sourceKey], source);
    let targetKey: string | null = null;
    let targetKeys: string[] = [];
    if (multiple) {
      const original = input.operation ? value : input.originalValue;
      if (
        !Array.isArray(original) ||
        Object.getPrototypeOf(original) !== Array.prototype ||
        !Array.isArray(value) ||
        value.length > 1000 ||
        Reflect.ownKeys(value).length !== value.length + 1 ||
        Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(value, index))
      )
        invalid('Reference values must be a bounded dense key array');
      targetKeys = value.length ? normalizeKeys(value, target) : [];
    } else {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number')
        invalid('Reference values must be a target key or null');
      targetKey = value === null ? null : normalizeKeys([value], target)[0];
    }
    const compiler = new AccessRoleFilterCompiler(this.db, this.resolveIdentity);
    let role: ReturnType<AccessRoleFilterCompiler['compile']> | undefined;
    let targetRole: ReturnType<AccessRoleFilterCompiler['compile']> | undefined;
    const metadata = accessMetadataGuard(
      this.db,
      [
        { model: source.model, config: relation.sourceConfig },
        { model: target.model, config: this.prepared.configuration(ctx, targetIdentity)! },
      ],
      [{ model: source.model, path: [name] }],
    );
    let assertTargetCurrent: (() => void) | undefined;
    const assertCurrent = () => {
      relation.current();
      metadata();
      role?.assertCurrent();
      targetRole?.assertCurrent();
      assertTargetCurrent?.();
      if (
        source.getField(name) !== field ||
        field.target !== target.name ||
        source.filterTargetKey !== source.model.primaryKeyAttribute
      )
        invalid('Reference source field or locator changed');
      const identities: Array<readonly [Collection, AccessCollectionIdentity]> = [
        [source, sourceIdentity],
        [target, targetIdentity],
      ];
      if (multiple) identities.push([through!, throughIdentity!]);
      for (const [collection, expected] of identities) {
        const actual = this.resolveIdentity(collection);
        if (
          !actual ||
          actual.collectionName !== expected.collectionName ||
          accessCollectionKey(actual) !== accessCollectionKey(expected)
        )
          invalid('Reference entry identity changed');
      }
    };
    assertCurrent();
    if (authorizeSource) {
      const related = await authorizeSource(source, input.operation!);
      assertCurrent();
      sourcePermission = captureAssociationSourcePermission(this.db, source, roleName, input.operation!, related);
    }
    if (!sourcePermission?.allowed) invalid('Reference source permission is unavailable');
    const checkFields = (
      permission: Readonly<AccessFinalActionPermission>,
      collection: Collection,
      required: string,
      alias?: string,
    ) => {
      shape(
        permission.params,
        input.operation
          ? ['fields', 'whitelist', 'blacklist', 'filter', 'own']
          : ['whitelist', 'blacklist', 'filter', 'own'],
      );
      if (permission.params.own !== undefined && permission.params.own !== false)
        invalid('Own-record mutation permissions must be finalized');
      for (const kind of ['fields', 'whitelist', 'blacklist']) {
        const value = permission.params[kind];
        if (value === undefined) continue;
        const fields = captureAccessFilter(value);
        if (
          !Array.isArray(fields) ||
          fields.some((field) => typeof field !== 'string') ||
          new Set(fields).size !== fields.length
        )
          invalid('Reference field grants must be distinct field names');
        for (const field of fields)
          if (
            !Object.hasOwn(collection.model.rawAttributes, field) &&
            !Object.hasOwn(collection.model.associations, field)
          )
            invalid('Reference permission contains unsupported fields');
        if (
          kind === 'blacklist'
            ? fields.includes(required) || (alias !== undefined && fields.includes(alias))
            : !fields.includes(required)
        )
          invalid('Reference field is not authorized');
      }
      return compiler.compile(
        collection === source ? sourceIdentity : targetIdentity,
        captureAccessFilter(permission.params.filter ?? {}),
      );
    };
    role = checkFields(sourcePermission, source, name, multiple ? undefined : relation.foreignKey);
    if (targetPermission) targetRole = checkFields(targetPermission, target, target.model.primaryKeyAttribute);
    assertCurrent();
    const entry = {
      assertCurrent,
      ...(targetRole
        ? {
            authorizeChanges: async (keys: string[], transaction: Transaction) => {
              assertCurrent();
              const primary = target.model.primaryKeyAttribute;
              const records = await target.model.unscoped().findAll(
                internalQuery({
                  attributes: [primary],
                  where: { [Op.and]: [{ [primary]: { [Op.in]: keys } }, targetRole!.rootWhere ?? targetRole!.where] },
                  transaction,
                  limit: keys.length,
                }),
              );
              assertCurrent();
              // Actual additions plus removals can exceed the request's individual key limit.
              const actual = new Set(records.map((record) => normalizeKeys([record.getDataValue(primary)], target)[0]));
              if (actual.size !== keys.length || keys.some((key) => !actual.has(key))) unavailable();
            },
          }
        : {}),
      targetScope: async () => {
        assertCurrent();
        const related = await authorizeTarget(target);
        assertCurrent();
        if (!related) invalid('Reference target is not authorized');
        const decision = captureRelatedReadPermission(this.db, target, roleName, related);
        const plan = new AccessReadGrantAdapter(this.db, (collection) => {
          const resolved = this.resolveIdentity(collection);
          return resolved && accessCollectionKey(resolved);
        }).capturePlan(targetIdentity, decision, compiler);
        if (!plan || !plan.grant.fields.includes(target.model.primaryKeyAttribute))
          invalid('Reference target key is not readable');
        assertTargetCurrent = plan.assertCurrent;
        assertCurrent();
        return { where: plan.grant.where };
      },
    };
    if (multiple) {
      ctx.body = await new AccessManyToManyService(
        this.db,
        this.prepared,
        this.queries,
        new AccessMutationService(this.db, this.prepared, this.queries),
        new AccessReferenceService(this.db, this.prepared, this.queries),
      ).withLinks(
        ctx,
        sourceIdentity,
        targetIdentity,
        throughIdentity!,
        actor,
        {
          association: name,
          operation: input.operation ?? 'set',
          sourceKeys: keys,
          targetKeys,
          sourceWhere: role.rootWhere ?? role.where,
        },
        entry,
      );
      return;
    }
    const links = new AccessBelongsToService(
      this.db,
      this.prepared,
      this.queries,
      new AccessMutationService(this.db, this.prepared, this.queries),
      new AccessReferenceService(this.db, this.prepared, this.queries),
    );
    const result = await links.withReference(
      ctx,
      sourceIdentity,
      targetIdentity,
      actor,
      { association: name, sourceKeys: keys, targetKey, sourceWhere: role.rootWhere ?? role.where },
      async (plan) => {
        assertCurrent();
        for (const record of plan.records) {
          await source.repository.update({
            filterByTk: record.getDataValue(source.model.primaryKeyAttribute),
            values: plan.valuesFor(record),
            transaction: plan.transaction,
            context: ctx,
          });
          assertCurrent();
        }
      },
      entry,
    );
    ctx.body = result;
  }
}
