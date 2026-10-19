import type { Collection, Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessCreationService } from './creation';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission } from './final-action-permission';
import { AccessMutationService } from './mutation';
import type { AccessQueryService } from './query';
import { AccessRoleFilterCompiler } from './role-filter';
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

/** Internal single-record scalar create/update/destroy bridge. No runtime routes are registered here. */
export class AccessRootMutationHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  async handle(ctx: AccessRootMutationContext, authenticated: AccessIdentity): Promise<void> {
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
    ]);
    const params = cloneDeep(raw);
    for (const [key, expected] of [
      ['resourceName', resourceName],
      ['actionName', operation],
      ['associatedName', undefined],
      ['associatedIndex', undefined],
    ] as const)
      if (Object.hasOwn(params, key) && params[key] !== expected) invalid('Mutation transport metadata does not match');
    const locator = params.filterByTk;
    if (operation === 'create') {
      if (locator !== undefined || params.resourceIndex !== undefined)
        invalid('Creation cannot supply record locators');
    } else if (
      !(
        (typeof locator === 'string' && locator.length > 0 && locator.length <= 255) ||
        (typeof locator === 'number' && Number.isSafeInteger(locator))
      )
    )
      invalid('Supply a single explicit record key');
    if (
      params.resourceIndex !== undefined &&
      (!['string', 'number'].includes(typeof params.resourceIndex) || String(params.resourceIndex) !== String(locator))
    )
      invalid('Mutation REST locator does not match its record key');
    // Core converts create/update field grants into whitelist before final ACL template resolution.
    shape(permission.params, ['whitelist', 'blacklist', 'filter', 'own']);
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
    const filter = captureAccessFilter(grants.filter === undefined ? {} : grants.filter);
    const collection = this.db.getCollection(resourceName);
    if (!collection || collection.db !== this.db || this.db.modelCollection.get(collection.model) !== collection)
      invalid('Mutation collection is unavailable');
    const identity = cloneDeep(this.resolveIdentity(collection));
    if (!identity || identity.collectionName !== resourceName) invalid('Mutation collection identity is unavailable');
    const key = accessCollectionKey(identity);
    const model = collection.model;
    if (operation !== 'create' && collection.filterTargetKey !== model.primaryKeyAttribute)
      invalid('Alternate mutation target keys require their own adapter');
    const keys = operation === 'create' ? [] : normalizeKeys([locator], collection);
    const config = this.prepared.configuration(ctx, identity);
    if (!config) invalid('Root mutation requires a prepared access configuration');
    if (
      [...(fields ?? []), ...(blacklist ?? [])].some(
        (field) =>
          !Object.hasOwn(model.rawAttributes, field) ||
          (model.rawAttributes[field].type as { key?: string }).key === 'VIRTUAL',
      )
    )
      invalid('Mutation permission contains unsupported fields');
    let values: Record<string, unknown> | undefined;
    if (operation !== 'destroy') {
      validateRootValues(this.db, params.values, collection, operation, config.ownership.enabled);
      const input = params.values as Record<string, unknown>;
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
    const role = new AccessRoleFilterCompiler(this.db, this.resolveIdentity).compile(identity, filter);
    const assertCurrent = () => {
      const current = this.resolveIdentity(collection);
      if (
        !current ||
        current.collectionName !== resourceName ||
        accessCollectionKey(current) !== key ||
        (operation !== 'create' && collection.filterTargetKey !== model.primaryKeyAttribute) ||
        this.prepared.configuration(ctx, identity) !== config ||
        !this.queries.isCurrentCollection(identity, collection, model)
      )
        invalid('Mutation entry identity or preparation phase changed');
      role.assertCurrent();
    };
    assertCurrent();
    if (operation === 'create') {
      const result = await new AccessCreationService(this.db, this.prepared, this.queries).withCreatedRecords(
        ctx,
        identity,
        actor,
        { values: [values!], where: role.rootWhere ?? role.where },
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
    const result = await new AccessMutationService(this.db, this.prepared, this.queries).withExistingRecords(
      ctx,
      identity,
      actor,
      { operation, keys, values, where: role.rootWhere ?? role.where },
      async (plan) => {
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
      },
      assertCurrent,
    );
    ctx.body = result;
  }
}
