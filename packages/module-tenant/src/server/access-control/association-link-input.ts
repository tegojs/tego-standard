import type { Collection, Database } from '@tego/server';

import type { AccessIdentity } from './context';
import { captureFinalActionPermission } from './final-action-permission';
import type { AccessRootReadContext } from './root-read-context';
import { cloneDeep, invalid, plain } from './write-support';

function data(input: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Association context cannot contain accessors');
  return descriptor.value;
}

function name(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) &&
    !['_', '__proto__', 'constructor', 'prototype'].includes(value)
  );
}

function key(value: unknown): value is string | number {
  return (
    (typeof value === 'string' && value.length > 0 && value.length <= 255 && value !== '_') ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  );
}

function transport(permission: unknown, expected: Record<string, unknown>, selectors: readonly string[]) {
  if (!plain(permission)) invalid('Association permission is unavailable');
  const raw = data(permission, 'rawParams');
  const allowed = [...Object.keys(expected), ...selectors, 'resourceIndex'];
  if (!plain(raw) || Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !allowed.includes(key)))
    invalid('Unsupported association parameters');
  for (const entry of Reflect.ownKeys(raw)) data(raw, entry);
  for (const [entry, value] of Object.entries(expected))
    if (Object.hasOwn(raw, entry) && data(raw, entry) !== value)
      invalid('Association transport metadata does not match');
  if (data(raw, 'resourceIndex') !== undefined) invalid('Association action requires a body or query selector');
  return raw;
}

/** Snapshot the real target action and concrete source before metadata or asynchronous authorization. */
export function captureAssociationLinkInput(
  db: Database,
  ctx: AccessRootReadContext,
  authenticated: AccessIdentity,
  associationType: 'BelongsToMany' | 'HasMany' | 'HasOne',
) {
  if (ctx.db !== db || !ctx.action || typeof ctx.action !== 'object' || !plain(authenticated))
    invalid('Association database or authenticated context is unavailable');
  const actor = Object.freeze(cloneDeep(authenticated));
  if (typeof actor.roleName !== 'string') invalid('Association writes require an authenticated role');
  const resource = data(ctx.action, 'resourceName');
  const operation = data(ctx.action, 'actionName');
  const sourceKey = data(ctx.action, 'sourceId');
  const resourceOf = data(ctx.action, 'resourceOf');
  if (
    typeof resource !== 'string' ||
    resource.split('.').length !== 2 ||
    !(associationType === 'HasOne' ? ['remove', 'set'] : ['add', 'remove', 'set']).includes(operation as string) ||
    !key(sourceKey) ||
    (resourceOf !== undefined && resourceOf !== sourceKey)
  )
    invalid('Unsupported concrete association action');
  const [resourceName, association] = resource.split('.');
  if (!name(resourceName) || !name(association)) invalid('Invalid association resource');
  if (!plain(ctx.permission)) invalid('Association target permission is unavailable');
  const targetName = data(ctx.permission, 'resourceName');
  if (!name(targetName)) invalid('Association target collection is unavailable');
  const permission = captureFinalActionPermission(ctx.permission, {
    resourceName: targetName,
    actionName: operation as string,
    roleName: actor.roleName,
  });
  if (!permission.allowed) invalid('Association operation is not authorized');
  const raw = transport(
    ctx.permission,
    {
      resourceName: association,
      actionName: operation,
      associatedName: resourceName,
      associatedIndex: sourceKey,
    },
    ['filterByTk', 'filterByTks', 'values'],
  );
  const selectors = ['filterByTk', 'filterByTks', 'values'].filter((entry) => data(raw, entry) !== undefined);
  const selectedValue = selectors.length === 1 ? data(raw, selectors[0]) : undefined;
  const selectorlessHasOneRemove =
    associationType === 'HasOne' &&
    operation === 'remove' &&
    (selectors.length === 0 ||
      (selectors.length === 1 &&
        selectors[0] === 'values' &&
        Array.isArray(selectedValue) &&
        selectedValue.length === 0));
  if (associationType === 'HasOne' && operation === 'remove' && !selectorlessHasOneRemove)
    invalid('HasOne remove does not accept target selectors');
  if (!selectorlessHasOneRemove && selectors.length !== 1) invalid('Association action requires one target selector');
  const value = selectorlessHasOneRemove ? [] : selectedValue;
  if (associationType === 'HasOne' && operation === 'set' && Array.isArray(value))
    invalid('HasOne set requires one scalar target');
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 1000 ||
      (!value.length && operation !== 'set' && !selectorlessHasOneRemove) ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      Array.from({ length: value.length }, (_, index) => index).some(
        (index) => !Object.hasOwn(value, index) || !key(data(value, index)),
      )
    )
      invalid('Association targets require a bounded dense key array');
  } else if (!key(value)) invalid('Association targets require primary keys');
  return {
    actor,
    resourceName,
    name: association,
    sourceKey,
    targetName,
    permission,
    operation: operation as 'add' | 'remove' | 'set',
    value: cloneDeep(Array.isArray(value) ? value : [value]),
  };
}

/** A target action never substitutes for an independently finalized source action. */
export function captureAssociationSourcePermission(
  db: Database,
  source: Collection,
  roleName: string,
  operation: 'add' | 'remove' | 'set' | 'update',
  related: AccessRootReadContext | null,
) {
  if (
    !related ||
    related.db !== db ||
    !related.action ||
    typeof related.action !== 'object' ||
    data(related.action, 'resourceName') !== source.name ||
    data(related.action, 'actionName') !== operation ||
    data(related.action, 'sourceId') !== undefined ||
    data(related.action, 'resourceOf') !== undefined
  )
    invalid('Association source requires an independent root action decision');
  const permission = captureFinalActionPermission(related.permission, {
    resourceName: source.name,
    actionName: operation,
    roleName,
  });
  if (!permission.allowed) invalid('Association source is not authorized');
  const raw = transport(
    related.permission,
    {
      resourceName: source.name,
      actionName: operation,
      associatedName: undefined,
      associatedIndex: undefined,
    },
    ['filterByTk'],
  );
  // Core initializes this own property to undefined even when there is no REST locator.
  if (data(raw, 'filterByTk') !== undefined) invalid('Association source decisions must be unfiltered');
  return permission;
}
