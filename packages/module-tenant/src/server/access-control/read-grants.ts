import { literal, Op, type Collection, type Database, type WhereOptions } from '@tego/server';

import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessFilterNode } from './filter-tree';
import { AccessRequestFilterParser, type AccessFilterReadGrant } from './request-filter';
import { cloneDeep, invalid, plain } from './write-support';

/** Server-finalized operation authorization, never action params or request headers. */
export interface AccessEntryReadPermission {
  allowed: boolean;
  /** After fixed scopes, middleware adjustments and ACL template resolution. */
  params: unknown;
}

function shape(input: unknown, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (
    !plain(input) ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'),
    )
  )
    invalid('Unsupported finalized read permission');
}

function names(input: unknown): string[] | undefined {
  if (input === undefined) return;
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > 1000 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid('Read permission fields must be a bounded dense list');
  const result: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' ||
      !descriptor.value.length ||
      result.includes(descriptor.value)
    )
      invalid('Read permission fields must be distinct names');
    result.push(descriptor.value);
  }
  return result;
}

/** Internal bridge only: the existing entry decides authorization for every path. */
export class AccessReadGrantAdapter {
  constructor(
    private readonly db: Database,
    private readonly resolveCollectionKey: (collection: Collection) => string | undefined,
  ) {}

  capture(identity: AccessCollectionIdentity, permission: AccessEntryReadPermission): AccessFilterReadGrant | null {
    shape(identity, ['dataSourceKey', 'collectionKey', 'collectionName']);
    identity = cloneDeep(identity);
    const key = accessCollectionKey(identity);
    const collection = this.db.getCollection(identity.collectionName);
    if (!collection || collection.db !== this.db || this.resolveCollectionKey(collection) !== key)
      invalid('Read permission does not match the registered collection identity');
    shape(permission, ['allowed', 'params']);
    if (typeof permission.allowed !== 'boolean' || !Object.hasOwn(permission, 'params'))
      invalid('Read permission must contain an explicit operation decision and final params');
    if (!permission.allowed) return null;
    shape(permission.params, ['fields', 'appends', 'filter', 'own']);
    const fields = names(permission.params.fields);
    const appends = names(permission.params.appends);
    const params = cloneDeep(permission.params);
    if (Object.hasOwn(params, 'own') && params.own !== false)
      invalid('Own-record permissions must be resolved before capturing read grants');
    const physical = Object.keys(collection.model.rawAttributes).filter(
      (name) => (collection.model.rawAttributes[name].type as { key?: string }).key !== 'VIRTUAL',
    );
    const relations = Object.keys(collection.model.associations);
    if (fields?.some((name) => !physical.includes(name)) || appends?.some((name) => !relations.includes(name)))
      invalid('Read permission contains unsupported fields or association paths');
    const outputFields = [...(fields ?? physical), ...(appends ?? (fields === undefined ? relations : []))];
    const filter = params.filter === undefined ? {} : params.filter;
    this.assertResolved(filter);
    // ACL conditions may use hidden root fields, independently of output authorization.
    const parsed = new AccessRequestFilterParser(this.db, (target, path) => {
      if (target !== collection || path.length) invalid('Relational role scopes require a dedicated entry adapter');
      return { identity, fields: physical };
    }).parse(identity, filter);
    return Object.freeze({
      identity: Object.freeze(identity),
      fields: Object.freeze(outputFields),
      where: this.where(parsed.filter),
    });
  }

  private assertResolved(value: unknown): void {
    if (typeof value === 'string' && (value.includes('{{') || value.includes('}}')))
      invalid('Read permission contains an unresolved ACL variable');
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) this.assertResolved(child);
    }
  }

  private where(node: AccessFilterNode): WhereOptions {
    const predicate = this.predicate(node);
    return typeof predicate === 'boolean' ? literal(predicate ? '1 = 1' : '1 = 0') : predicate;
  }

  private predicate(node: AccessFilterNode): WhereOptions | boolean {
    switch (node.type) {
      case 'predicate':
        return node.where;
      case 'all':
      case 'any': {
        const conjunction = node.type === 'all';
        const children = node.children.map((child) => this.predicate(child));
        // Sequelize omits empty TRUE groups in an OR. Fold constants before constructing ORM conditions.
        if (children.includes(!conjunction)) return !conjunction;
        const predicates = children.filter((child): child is WhereOptions => typeof child !== 'boolean');
        if (!predicates.length) return conjunction;
        return { [conjunction ? Op.and : Op.or]: predicates };
      }
      case 'not': {
        const child = this.predicate(node.child);
        return typeof child === 'boolean' ? !child : { [Op.not]: child };
      }
      default:
        return invalid('Relational role scopes require a dedicated entry adapter');
    }
  }
}
