import { Op, type Collection, type Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { captureAttachmentCreation } from './attachment-creation-entry';
import { captureAttachmentRemoval } from './attachment-removal-entry';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessCreationService } from './creation';
import { assertCreationKeyArray } from './creation-links';
import { prepareCreationReferences, type AccessCreationTargetAuthorizer } from './creation-reference';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission } from './final-action-permission';
import { AccessMutationService, type ExistingAccessWritePlan } from './mutation';
import { AccessMutationError } from './mutation-errors';
import type { AccessQueryService } from './query';
import { prepareRelationalMutationFilter } from './relational-mutation-filter';
import { AccessRoleFilterCompiler } from './role-filter';
import { prepareScalarMutationFilter } from './scalar-mutation-filter';
import { cloneDeep, invalid, normalizeKeys, plain, validateRootValues } from './write-support';

interface AccessRootMutationContext {
  db: Database;
  action: object;
  permission: unknown;
  body?: unknown;
}

function data(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Mutation context cannot contain accessors');
  return descriptor.value;
}

function shape(input: unknown, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (!plain(input) || Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !keys.includes(key)))
    invalid('Unsupported root mutation parameters');
  for (const key of Reflect.ownKeys(input)) data(input, key);
}

/** Internal root creation and scalar mutation bridge. No runtime routes are registered here. */
export class AccessRootMutationHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  /** Trusted selected file executor: capture final ACL before any staging, then use its owned transaction. */
  captureAttachment(ctx: AccessRootMutationContext, authenticated: AccessIdentity) {
    return captureAttachmentCreation(this.db, this.prepared, this.queries, this.resolveIdentity, ctx, authenticated);
  }

  /** Internal preparation or explicit owned SQL executor. Never authorizes physical cleanup. */
  captureAttachmentRemoval(ctx: AccessRootMutationContext, authenticated: AccessIdentity) {
    return captureAttachmentRemoval(this.db, this.prepared, this.queries, this.resolveIdentity, ctx, authenticated);
  }

  async handle(
    ctx: AccessRootMutationContext,
    authenticated: AccessIdentity,
    authorizeRead?: AccessCreationTargetAuthorizer,
  ): Promise<void> {
    if (ctx.db !== this.db || !ctx.action || typeof ctx.action !== 'object' || !plain(authenticated))
      invalid('Root mutation database or authenticated context is unavailable');
    const resourceName = data(ctx.action, 'resourceName');
    const actionName = data(ctx.action, 'actionName');
    if (
      typeof resourceName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(resourceName) ||
      ['_', '__proto__', 'constructor', 'prototype'].includes(resourceName) ||
      typeof actionName !== 'string' ||
      !['create', 'update', 'destroy'].includes(actionName) ||
      data(ctx.action, 'sourceId') !== undefined ||
      data(ctx.action, 'resourceOf') !== undefined
    )
      invalid('Unsupported root mutation action');
    const operation = actionName as 'create' | 'update' | 'destroy';
    const actor = Object.freeze(cloneDeep(authenticated));
    if (typeof actor.roleName !== 'string') invalid('Root mutations require an authenticated role');
    const permission = captureFinalActionPermission(ctx.permission, {
      resourceName,
      actionName: operation,
      roleName: actor.roleName,
    });
    if (!permission.allowed) invalid('Root mutation is not authorized');
    if (!plain(ctx.permission)) invalid('Final mutation context is unavailable');
    const raw = data(ctx.permission, 'rawParams');
    shape(raw, [
      'resourceName',
      'actionName',
      'associatedName',
      'associatedIndex',
      'resourceIndex',
      'filterByTk',
      'values',
      ...(operation === 'create' ? [] : ['filter']),
      ...(operation === 'update' ? ['forceUpdate'] : []),
    ]);
    // Bulk-edit clients send false, serialized as 'false' in query strings; neither supplies selection.
    // 批量编辑客户端的 false 在查询串中为 'false'；两种形式均不提供选中范围。
    const forceUpdate = data(raw, 'forceUpdate');
    if (Object.hasOwn(raw, 'forceUpdate') && forceUpdate !== false && forceUpdate !== 'false')
      invalid('Unsupported root mutation parameters');
    const rawFilter = data(raw, 'filter');
    const requestFilter = rawFilter === undefined ? {} : captureAccessFilter(rawFilter);
    if (!plain(requestFilter)) invalid('Mutation request filters must be plain objects');
    const filtered = Reflect.ownKeys(requestFilter).length > 0;
    if (filtered && !authorizeRead) invalid('Filtered mutations require an independent read decision');
    // cloneDeep deliberately normalizes array prototypes; validate raw selections first.
    const rawLocator = data(raw, 'filterByTk');
    if (Array.isArray(rawLocator)) {
      if (
        Object.getPrototypeOf(rawLocator) !== Array.prototype ||
        !rawLocator.length ||
        rawLocator.length > 1000 ||
        Reflect.ownKeys(rawLocator).length !== rawLocator.length + 1
      )
        invalid('Record selections require between 1 and 1000 dense keys');
      for (let index = 0; index < rawLocator.length; index++) {
        if (!Object.hasOwn(rawLocator, index)) invalid('Record selections cannot contain holes');
        data(rawLocator, String(index));
      }
    }
    const rawValues = data(raw, 'values');
    if (operation === 'create' && plain(rawValues))
      for (const name of Reflect.ownKeys(rawValues)) {
        const value = data(rawValues, name);
        if (
          typeof name === 'string' &&
          this.db.getCollection(resourceName)?.model.associations[name]?.associationType === 'BelongsToMany'
        )
          assertCreationKeyArray(value);
      }
    const params = cloneDeep(raw);
    for (const [key, expected] of [
      ['resourceName', resourceName],
      ['actionName', operation],
      ['associatedName', undefined],
      ['associatedIndex', undefined],
    ] as const)
      if (Object.hasOwn(params, key) && params[key] !== expected) invalid('Mutation transport metadata does not match');
    const locator = params.filterByTk;
    const matching = operation !== 'create' && locator === undefined && filtered;
    const locators = Array.isArray(locator) ? locator : [locator];
    if (operation === 'create') {
      if (locator !== undefined || params.resourceIndex !== undefined)
        invalid('Creation cannot supply record locators');
    } else if (
      !matching &&
      locators.some(
        (key) =>
          !(
            (typeof key === 'string' && key.length > 0 && key.length <= 255) ||
            (typeof key === 'number' && Number.isSafeInteger(key))
          ),
      )
    )
      invalid('Supply explicit scalar record keys');
    if (
      params.resourceIndex !== undefined &&
      (Array.isArray(locator) ||
        !['string', 'number'].includes(typeof params.resourceIndex) ||
        String(params.resourceIndex) !== String(locator))
    )
      invalid('Mutation REST locator does not match its record key');
    // Core converts create/update fields to whitelist, but retains fields as metadata for destroy.
    shape(permission.params, [
      'whitelist',
      'blacklist',
      'filter',
      'own',
      ...(operation === 'destroy' ? ['fields'] : []),
    ]);
    const grants = cloneDeep(permission.params);
    if (Object.hasOwn(grants, 'own') && grants.own !== false)
      invalid('Own-record mutation permissions must be finalized');
    const fieldNames = (value: unknown) => {
      if (value === undefined) return;
      const input = captureAccessFilter(value);
      if (
        !Array.isArray(input) ||
        input.some((field) => typeof field !== 'string') ||
        new Set(input).size !== input.length
      )
        invalid('Mutation permission fields must be distinct physical field names');
      return input as string[];
    };
    const fields = fieldNames(grants.whitelist);
    const blacklist = fieldNames(grants.blacklist);
    const destroyFields = fieldNames(grants.fields);
    const filter = captureAccessFilter(grants.filter === undefined ? {} : grants.filter);
    const collection = this.db.getCollection(resourceName);
    if (!collection || collection.db !== this.db || this.db.modelCollection.get(collection.model) !== collection)
      invalid('Mutation collection is unavailable');
    const template = collection.options.template;
    if (operation === 'destroy' && template === 'file')
      throw new AccessMutationError(
        'UNSUPPORTED_ACCESS_MUTATION',
        'Attachment deletion requires its own authorization and storage coordinator',
        400,
      );
    const identity = cloneDeep(this.resolveIdentity(collection));
    if (!identity || identity.collectionName !== resourceName) invalid('Mutation collection identity is unavailable');
    const key = accessCollectionKey(identity);
    const model = collection.model;
    if (
      destroyFields?.some(
        (field) => !Object.hasOwn(model.rawAttributes, field) && !Object.hasOwn(model.associations, field),
      )
    )
      invalid('Mutation permission contains unsupported fields');
    if (operation !== 'create' && collection.filterTargetKey !== model.primaryKeyAttribute)
      invalid('Alternate mutation target keys require their own adapter');
    const keys = operation === 'create' || matching ? [] : normalizeKeys(locators, collection);
    const config = this.prepared.configuration(ctx, identity);
    if (!config) invalid('Root mutation requires a prepared access configuration');
    const reference =
      operation === 'create' && authorizeRead
        ? prepareCreationReferences(
            this.db,
            this.prepared,
            this.queries,
            this.resolveIdentity,
            ctx,
            identity,
            params.values,
            permission,
            actor.roleName,
            authorizeRead,
          )
        : undefined;
    if (
      [...(fields ?? []), ...(blacklist ?? [])].some(
        (field) =>
          !Object.hasOwn(model.associations, field) &&
          (!Object.hasOwn(model.rawAttributes, field) ||
            (model.rawAttributes[field].type as { key?: string }).key === 'VIRTUAL'),
      )
    )
      invalid('Mutation permission contains unsupported fields');
    let values: Record<string, unknown> | undefined;
    if (operation !== 'destroy') {
      const input = (reference?.values ?? params.values) as Record<string, unknown>;
      validateRootValues(this.db, input, collection, operation, config.ownership.enabled);
      // Managed tenantId is retained for the service's exact anti-transfer/legacy-claim validation.
      values = Object.fromEntries(
        Object.keys(input)
          .filter(
            (field) =>
              ((fields === undefined || fields.includes(field)) && !blacklist?.includes(field)) ||
              (config.ownership.enabled && field === 'tenantId'),
          )
          .map((field) => [field, input[field]]),
      );
      if (
        operation === 'update' &&
        !Object.keys(values).some((field) => !config.ownership.enabled || field !== 'tenantId')
      )
        invalid('No authorized fields to update');
    } else if (params.values !== undefined) invalid('Deletion cannot supply values');
    const compiler = new AccessRoleFilterCompiler(this.db, this.resolveIdentity);
    const role = compiler.compile(identity, filter);
    const relational =
      operation !== 'create' && filtered
        ? prepareRelationalMutationFilter(
            this.db,
            this.prepared,
            this.queries,
            ctx,
            collection,
            identity,
            actor,
            requestFilter,
            this.resolveIdentity,
          )
        : undefined;
    const selection = relational
      ? undefined
      : prepareScalarMutationFilter(
          this.db,
          collection,
          identity,
          config,
          requestFilter,
          actor.roleName,
          compiler,
          this.resolveIdentity,
        );
    const assertCurrent = () => {
      const current = this.resolveIdentity(collection);
      if (
        !current ||
        current.collectionName !== resourceName ||
        accessCollectionKey(current) !== key ||
        collection.options.template !== template ||
        (operation !== 'create' && collection.filterTargetKey !== model.primaryKeyAttribute) ||
        this.prepared.configuration(ctx, identity) !== config ||
        !this.queries.isCurrentCollection(identity, collection, model)
      )
        invalid('Mutation entry identity or preparation phase changed');
      role.assertCurrent();
      reference?.assertCurrent();
      selection?.assertCurrent();
      relational?.assertCurrent();
    };
    assertCurrent();
    if (operation === 'create') {
      const target = await reference?.resolve();
      assertCurrent();
      const result = await new AccessCreationService(this.db, this.prepared, this.queries).withCreatedRecords(
        ctx,
        identity,
        actor,
        {
          values: [values!],
          where: role.rootWhere ?? role.where,
          references: target?.references,
          links: target?.links,
        },
        async (plan) => {
          assertCurrent();
          const record = await collection.repository.create({
            values: plan.values[0],
            transaction: plan.transaction,
            context: ctx,
          });
          assertCurrent();
          return [record];
        },
        assertCurrent,
      );
      ctx.body = result;
      return;
    }
    const requested = selection ? await selection.resolve(authorizeRead, assertCurrent) : undefined;
    const relatedSelection = relational ? await relational.resolve(authorizeRead, assertCurrent) : undefined;
    const where = requested ? { [Op.and]: [role.rootWhere ?? role.where, requested] } : (role.rootWhere ?? role.where);
    const mutations = new AccessMutationService(this.db, this.prepared, this.queries);
    const writer = async (plan: ExistingAccessWritePlan) => {
      assertCurrent();
      for (const record of plan.records) {
        const filterByTk = record.getDataValue(model.primaryKeyAttribute) as string | number;
        if (operation === 'update')
          await collection.repository.update({
            filterByTk,
            values: plan.valuesFor(record),
            transaction: plan.transaction,
            context: ctx,
          });
        else await collection.repository.destroy({ filterByTk, transaction: plan.transaction, context: ctx });
        assertCurrent();
      }
    };
    const result = relatedSelection
      ? await mutations.withSelectedRecords(
          ctx,
          identity,
          actor,
          matching ? { operation, values, where } : { operation, keys, values, where },
          relatedSelection,
          writer,
          assertCurrent,
        )
      : matching
        ? await mutations.withMatchingRecords(ctx, identity, actor, { operation, values, where }, writer, assertCurrent)
        : await mutations.withExistingRecords(
            ctx,
            identity,
            actor,
            { operation, keys, values, where },
            writer,
            assertCurrent,
          );
    ctx.body = result;
  }
}
