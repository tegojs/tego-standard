import { isDeepStrictEqual as isEqual } from 'node:util';
import type { Database, Model, Transaction } from '@tego/server';

import { AccessConfigError } from './config-errors';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessConfig } from './types';

interface ConfigWrite {
  identity: AccessCollectionIdentity;
  config: AccessConfig;
  actorUserId: string;
}

const writes = new WeakMap<Database, WeakMap<Transaction, ConfigWrite>>();
const registered = new WeakSet<Database>();

/** Server-only transaction capability. No serializable request flag can reproduce it. */
export function beginConfigWrite(db: Database, transaction: Transaction, write: ConfigWrite) {
  let pending = writes.get(db);
  if (!pending) {
    pending = new WeakMap();
    writes.set(db, pending);
  }
  pending.set(transaction, write);
}

export function endConfigWrite(db: Database, transaction: Transaction) {
  writes.get(db)?.delete(transaction);
}

function invalid(message: string): never {
  throw new AccessConfigError('INVALID_ACCESS_CONFIG_WRITE', message);
}

interface SaveOptions {
  transaction?: Transaction;
  values?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

/** Explicit integration step; creating a store does not modify the app's existing hooks. */
export function registerAccessConfigGuards(db: Database) {
  if (registered.has(db)) return;
  if (['collections', 'dataSourcesCollections', 'tenantAccessRevisions'].some((name) => !db.hasCollection(name))) {
    invalid('Load metadata and audit collections before registering configuration guards');
  }
  for (const name of ['collections', 'dataSourcesCollections']) {
    db.on(`${name}.beforeSave`, async (model: Model, options: SaveOptions) => {
      const movingSource = name === 'dataSourcesCollections' && model.changed('dataSourceKey');
      if (!model.changed('options') && !movingSource) return;
      const incoming = model.getDataValue('options') ?? {};
      if (typeof incoming !== 'object' || Array.isArray(incoming)) invalid('Invalid collection metadata options');
      if (model.isNewRecord) {
        if (Object.hasOwn(incoming, 'tenantAccess')) invalid('Create metadata first, then save access configuration');
        return;
      }
      const transaction = options.transaction;
      if (!transaction) invalid('Collection option changes require a metadata transaction');
      const current = await db.getCollection(name).model.findByPk(model.getDataValue('key'), {
        transaction,
        lock: transaction.LOCK.UPDATE,
        useMaster: true,
      });
      if (!current) invalid('Collection metadata disappeared during save');
      const stored = current.getDataValue('options') ?? {};
      if (movingSource && Object.hasOwn(stored, 'tenantAccess')) {
        invalid('Configured collection metadata cannot move between data sources');
      }
      const write = writes.get(db)?.get(transaction);
      if (
        write &&
        write.identity.collectionKey === model.getDataValue('key') &&
        write.identity.collectionName === model.getDataValue('name') &&
        write.identity.dataSourceKey === (name === 'collections' ? 'main' : model.getDataValue('dataSourceKey'))
      ) {
        if (!isEqual(incoming.tenantAccess, write.config)) invalid('Configuration does not match validated write');
        return;
      }
      // Repository options.values retain the actual patch. Direct model saves use the previous value.
      const patch = options.values ?? options.attributes;
      const nested = patch?.options;
      const explicit = patch
        ? Object.hasOwn(patch, 'tenantAccess') ||
          (nested && typeof nested === 'object' && Object.hasOwn(nested, 'tenantAccess')) ||
          Object.keys(patch).some((key) => key.startsWith('options.tenantAccess.') || key.startsWith('tenantAccess.'))
        : Object.hasOwn(incoming, 'tenantAccess') &&
          !isEqual(incoming.tenantAccess, model.previous('options')?.tenantAccess);
      if (explicit && !isEqual(incoming.tenantAccess, stored.tenantAccess)) {
        invalid('Access configuration changes must use the versioned configuration service');
      }
      const preserved = { ...incoming };
      if (Object.hasOwn(stored, 'tenantAccess')) preserved.tenantAccess = structuredClone(stored.tenantAccess);
      else delete preserved.tenantAccess;
      model.setDataValue('options', preserved);
    });
    db.on(`${name}.beforeBulkUpdate`, (options: { individualHooks?: boolean; attributes: Record<string, unknown> }) => {
      if (
        !options.individualHooks &&
        (Object.hasOwn(options.attributes, 'options') || Object.hasOwn(options.attributes, 'dataSourceKey'))
      ) {
        invalid('Bulk metadata option updates require individual validation');
      }
    });
    // Bulk-create/upsert arguments do not reliably carry a model name for Database event routing.
    const model = db.getCollection(name).model;
    model.addHook('beforeBulkCreate', 'tenant-access-config', (instances, options) => {
      if (
        options.updateOnDuplicate?.some((key) => key === 'options' || key === 'dataSourceKey') ||
        instances.some((instance) => Object.hasOwn(instance.getDataValue('options') ?? {}, 'tenantAccess'))
      ) {
        invalid('Bulk metadata creation cannot copy or replace access configuration');
      }
    });
    model.addHook('beforeUpsert', 'tenant-access-config', (values) => {
      if (Object.hasOwn(values, 'options') || Object.hasOwn(values, 'dataSourceKey'))
        invalid('Metadata option upserts require the configuration service');
    });
  }
  db.on('tenantAccessRevisions.beforeCreate', (model: Model, options: SaveOptions) => {
    const write = options.transaction ? writes.get(db)?.get(options.transaction) : undefined;
    if (
      !write ||
      model.get('dataSourceKey') !== write.identity.dataSourceKey ||
      model.get('collectionKey') !== write.identity.collectionKey ||
      model.get('collectionName') !== write.identity.collectionName ||
      model.get('actorUserId') !== write.actorUserId ||
      !isEqual(model.get('config'), write.config)
    ) {
      invalid('Access configuration revisions can only be created by the configuration service');
    }
  });
  for (const event of ['beforeUpdate', 'beforeDestroy', 'beforeBulkUpdate', 'beforeBulkDestroy']) {
    db.on(`tenantAccessRevisions.${event}`, () => invalid('Access configuration revisions are immutable'));
  }
  const history = db.getCollection('tenantAccessRevisions').model;
  history.addHook('beforeBulkCreate', 'tenant-access-config', () =>
    invalid('Access configuration revisions cannot be bulk-created'),
  );
  history.addHook('beforeUpsert', 'tenant-access-config', () =>
    invalid('Access configuration revisions are immutable'),
  );
  registered.add(db);
}
