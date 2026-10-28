import { Transaction, type Collection, type Database } from '@tego/server';

import { accessCollectionKey, type AccessCollectionIdentity, type AccessConfigStore } from './config-store';
import { captureAccessFilter } from './filter-input';
import { accessMetadataGuard } from './metadata-snapshot';
import { AccessMutationError } from './mutation-errors';
import { AccessRoleFilterCompiler } from './role-filter';
import type { AccessConfig } from './types';
import { cloneDeep, invalid, plain, requiresSerializable } from './write-support';

export interface AccessWorkflowWriteTransactionTarget {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: unknown;
  readonly valueFields?: readonly string[];
  readonly filter?: unknown;
  readonly captureFilter?: () => unknown;
}

/** Pure option selection, not a claim that a PostgreSQL transaction has been opened or verified. */
export function workflowWriteTransactionOptions(
  dialect: string,
  config: AccessConfig,
  collection: Collection,
  associationWrite = false,
) {
  const serializable = associationWrite || requiresSerializable(config, {}, collection);
  if (dialect === 'postgres') return serializable ? { isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE } : {};
  if (dialect !== 'sqlite' || serializable)
    throw new AccessMutationError(
      'UNSUPPORTED_ACCESS_MUTATION',
      serializable ? 'Relational writes require PostgreSQL' : 'Mutation dialect has not been validated',
      400,
    );
  return { type: Transaction.TYPES.IMMEDIATE };
}

/** Internal only; transaction policy does not authorize any business operation. */
export class AccessWorkflowWriteTransactionPlanner {
  constructor(
    private readonly db: Database,
    private readonly store: AccessConfigStore,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  async plan(target: AccessWorkflowWriteTransactionTarget) {
    if (
      !plain(target) ||
      Reflect.ownKeys(target).some(
        (name) =>
          !['dataSourceName', 'collectionName', 'collection', 'valueFields', 'filter', 'captureFilter'].includes(
            name as string,
          ) || !Object.hasOwn(Object.getOwnPropertyDescriptor(target, name)!, 'value'),
      )
    )
      invalid('Workflow transaction planning requires a target and selection descriptor');
    if (
      target.captureFilter !== undefined &&
      (typeof target.captureFilter !== 'function' || Object.hasOwn(target, 'filter'))
    )
      invalid('Workflow planning requires one unambiguous selection descriptor');
    // Capture before any metadata resolver can observe or change the caller's selection.
    const inputFilter = target.captureFilter === undefined ? target.filter : target.captureFilter();
    const filter = inputFilter === undefined ? undefined : captureAccessFilter(inputFilter);
    const { dataSourceName, collectionName, collection: supplied } = target;
    if (typeof dataSourceName !== 'string' || typeof collectionName !== 'string')
      invalid('Workflow transaction target is unavailable');
    const collection = this.db.getCollection(collectionName);
    if (
      !collection ||
      collection !== supplied ||
      collection.db !== this.db ||
      collection.model.sequelize !== this.db.sequelize
    )
      invalid('Workflow transaction target does not match its database');
    const input = target.valueFields;
    if (
      input !== undefined &&
      (!Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        input.length > 10000 ||
        Reflect.ownKeys(input).length !== input.length + 1 ||
        Array.from({ length: input.length }, (_, index) => index).some((index) => !Object.hasOwn(input, index)))
    )
      invalid('Workflow planning field names require a dense list');
    const fields = input === undefined ? [] : cloneDeep(input);
    if (fields.some((field) => typeof field !== 'string' || !field) || new Set(fields).size !== fields.length)
      invalid('Workflow planning field names must be distinct strings');
    const associations = fields.filter((field) => Object.hasOwn(collection.model.associations, field));
    const metadata = accessMetadataGuard(
      this.db,
      [],
      [
        { model: collection.model, path: [] },
        ...associations.map((field) => ({ model: collection.model, path: [field] })),
      ],
    );
    const identity = this.resolveIdentity(collection);
    if (!plain(identity) || identity.dataSourceKey !== dataSourceName || identity.collectionName !== collectionName)
      invalid('Workflow transaction identity does not match its target');
    const source = Object.freeze(cloneDeep(identity));
    const key = accessCollectionKey(source);
    // Inspect the captured selection only for transaction requirements. This grants no read or write access.
    const selection =
      filter === undefined
        ? undefined
        : new AccessRoleFilterCompiler(this.db, this.resolveIdentity).compile(source, filter);
    const assertCurrent = () => {
      metadata();
      selection?.assertCurrent();
      const current = this.resolveIdentity(collection);
      metadata();
      if (!current || current.collectionName !== source.collectionName || accessCollectionKey(current) !== key)
        invalid('Workflow transaction identity changed during planning');
    };
    const config = await this.store.read(source);
    assertCurrent();
    if (!config) invalid('Workflow transaction planning requires an explicit access configuration');
    return workflowWriteTransactionOptions(
      this.db.sequelize.getDialect(),
      config,
      collection,
      associations.length > 0 || (selection !== undefined && selection.rootWhere === undefined),
    );
  }
}
