import { Transaction, type Collection, type Database } from '@tego/server';

import { accessCollectionKey, type AccessCollectionIdentity, type AccessConfigStore } from './config-store';
import { accessMetadataGuard } from './metadata-snapshot';
import { AccessMutationError } from './mutation-errors';
import type { AccessConfig } from './types';
import { cloneDeep, invalid, plain, requiresSerializable } from './write-support';

export interface AccessWorkflowDestroyTransactionTarget {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: unknown;
}

/** Pure option selection, not a claim that a PostgreSQL transaction has been opened or verified. */
export function workflowDestroyTransactionOptions(dialect: string, config: AccessConfig, collection: Collection) {
  const serializable = requiresSerializable(config, {}, collection);
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
export class AccessWorkflowDestroyTransactionPlanner {
  constructor(
    private readonly db: Database,
    private readonly store: AccessConfigStore,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  async plan(target: AccessWorkflowDestroyTransactionTarget) {
    if (
      !plain(target) ||
      Reflect.ownKeys(target).some(
        (name) =>
          !['dataSourceName', 'collectionName', 'collection'].includes(name as string) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(target, name)!, 'value'),
      )
    )
      invalid('Workflow transaction planning requires a target-only descriptor');
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
    const identity = this.resolveIdentity(collection);
    if (!plain(identity) || identity.dataSourceKey !== dataSourceName || identity.collectionName !== collectionName)
      invalid('Workflow transaction identity does not match its target');
    const source = Object.freeze(cloneDeep(identity));
    const key = accessCollectionKey(source);
    const metadata = accessMetadataGuard(this.db, [], [{ model: collection.model, path: [] }]);
    const assertCurrent = () => {
      metadata();
      const current = this.resolveIdentity(collection);
      if (!current || current.collectionName !== source.collectionName || accessCollectionKey(current) !== key)
        invalid('Workflow transaction identity changed during planning');
    };
    const config = await this.store.read(source);
    assertCurrent();
    if (!config) invalid('Workflow transaction planning requires an explicit access configuration');
    return workflowDestroyTransactionOptions(this.db.sequelize.getDialect(), config, collection);
  }
}
