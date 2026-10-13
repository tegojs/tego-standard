import { MagicAttributeModel, type Database } from '@tego/server';

import { accessConfigHistory } from '../../access-control/config-history';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import type { AccessConfig } from '../../access-control/types';
import { configFor, documents, ownerCondition } from './fixtures';

export const mainIdentity = { dataSourceKey: 'main', collectionKey: 'documents-key', collectionName: 'documents' };
export const externalIdentity = { ...mainIdentity, dataSourceKey: 'external', collectionKey: 'external-documents-key' };

export function registerConfigModels(db: Database) {
  db.registerModels({ MagicAttributeModel });
  for (const name of ['collections', 'dataSourcesCollections']) {
    db.collection({
      name,
      tableName: `access_config_${name}`,
      model: 'MagicAttributeModel',
      timestamps: false,
      autoGenId: false,
      filterTargetKey: name === 'collections' ? 'name' : 'key',
      fields: [
        { name: 'key', type: 'string', primaryKey: true },
        { name: 'name', type: 'string' },
        ...(name === 'dataSourcesCollections' ? [{ name: 'dataSourceKey', type: 'string' }] : []),
        { name: 'options', type: 'json', defaultValue: {} },
      ],
    });
  }
  db.collection(accessConfigHistory);
}

export async function seedConfigStore(db: Database) {
  registerConfigModels(db);
  await db.sync();
  await db.getRepository('collections').create({
    values: { key: mainIdentity.collectionKey, name: 'documents', title: 'Documents', tenancy: 'tenantScoped' },
  });
  await db.getRepository('dataSourcesCollections').create({
    values: { key: externalIdentity.collectionKey, name: 'documents', dataSourceKey: 'external', title: 'External' },
  });
}

export function configStore(db: Database) {
  return new AccessConfigStore(db, (identity) => ({ ...documents, key: accessCollectionKey(identity) }));
}

export function initialConfig(): AccessConfig {
  return { ...configFor(ownerCondition), revision: 0 };
}
