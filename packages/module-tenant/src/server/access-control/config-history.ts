import type { CollectionOptions } from '@tego/server';

/** Internal audit collection. HTTP integration must not grant revision mutation actions. */
export const accessConfigHistory: CollectionOptions = {
  name: 'tenantAccessRevisions',
  dumpRules: 'required',
  shared: true,
  timestamps: false,
  indexes: [{ unique: true, fields: ['dataSourceKey', 'collectionKey', 'revision'] }],
  fields: [
    { name: 'dataSourceKey', type: 'string', allowNull: false },
    { name: 'collectionKey', type: 'string', allowNull: false },
    { name: 'collectionName', type: 'string', allowNull: false },
    { name: 'revision', type: 'bigInt', allowNull: false },
    { name: 'config', type: 'json', allowNull: false },
    { name: 'previousConfig', type: 'json' },
    { name: 'actorUserId', type: 'string', allowNull: false },
    { name: 'savedAt', type: 'date', allowNull: false },
  ],
};
