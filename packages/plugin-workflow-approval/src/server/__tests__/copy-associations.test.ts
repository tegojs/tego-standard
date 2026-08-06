import { describe, expect, it, vi } from 'vitest';

import { cleanCopyAssociationData } from '../copy-associations';

function createCollection(fields: Record<string, any>, options: Record<string, any> = {}) {
  return {
    ...options,
    getField: (name: string) => fields[name],
  };
}

describe('cleanCopyAssociationData', () => {
  it('preserves primitive association ids from the source data', () => {
    const targetCollection = createCollection(
      {},
      {
        filterTargetKey: 'id',
        model: { primaryKeyAttributes: ['id'], primaryKeyAttribute: 'id' },
      },
    );
    const collection = createCollection(
      {
        details: { type: 'hasMany', target: 'details' },
      },
      { db: { getCollection: () => targetCollection } },
    );
    const sourceData = { details: [7] };
    const copiedData = { details: [8] };

    expect(cleanCopyAssociationData(sourceData, copiedData, collection as any, ['details'])).toEqual({
      details: [7],
    });
  });

  it('removes the parent foreign key from copied hasMany records', () => {
    const targetCollection = createCollection(
      {},
      {
        filterTargetKey: 'id',
        model: { primaryKeyAttributes: ['id'], primaryKeyAttribute: 'id' },
      },
    );
    const collection = createCollection(
      {
        details: { type: 'hasMany', target: 'details', foreignKey: 'rootId' },
      },
      { db: { getCollection: () => targetCollection } },
    );

    expect(
      cleanCopyAssociationData(
        { details: [{ id: 2, rootId: 1, amount: 3 }] },
        { details: [{ id: 2, rootId: 1, amount: 3 }] },
        collection as any,
        ['details'],
      ),
    ).toEqual({ details: [{ amount: 3 }] });
  });

  it('removes the old foreign key from the owner of a copied belongsTo association', () => {
    const targetCollection = createCollection(
      {},
      {
        filterTargetKey: 'id',
        model: { primaryKeyAttributes: ['id'], primaryKeyAttribute: 'id' },
      },
    );
    const collection = createCollection(
      {
        account: { type: 'belongsTo', target: 'accounts', foreignKey: 'accountId' },
      },
      { db: { getCollection: () => targetCollection } },
    );

    expect(
      cleanCopyAssociationData(
        { accountId: 7, account: { id: 7, name: 'source' } },
        { accountId: 7, account: { id: 7, name: 'source' } },
        collection as any,
        ['account'],
      ),
    ).toEqual({ account: { name: 'source' } });
  });

  it('keeps the traversed value for non-JSON object association values', () => {
    const targetCollection = createCollection(
      {},
      {
        filterTargetKey: 'id',
        model: { primaryKeyAttributes: ['id'], primaryKeyAttribute: 'id' },
      },
    );
    const collection = createCollection(
      { details: { type: 'hasOne', target: 'details' } },
      { db: { getCollection: () => targetCollection } },
    );

    expect(
      cleanCopyAssociationData(
        { details: new Date('2020-01-01T00:00:00.000Z') },
        { details: '2020-01-01T00:00:00.000Z' },
        collection as any,
        ['details'],
      ),
    ).toEqual({ details: '2020-01-01T00:00:00.000Z' });
  });

  it('resolves association targets through the application data source manager', () => {
    const targetCollection = createCollection(
      {},
      {
        filterTargetKey: 'id',
        model: { primaryKeyAttributes: ['id'], primaryKeyAttribute: 'id' },
      },
    );
    const getCollection = vi.fn().mockReturnValue(targetCollection);
    const app = {
      dataSourceManager: {
        dataSources: new Map([['external', { collectionManager: { getCollection } }]]),
      },
    };
    const collection = createCollection(
      {
        details: { type: 'hasMany', target: 'details' },
      },
      { dataSource: 'external' },
    );

    const result = cleanCopyAssociationData(
      { details: [{ id: 12, amount: 3 }] },
      { details: [{ id: 12, amount: 3 }] },
      collection as any,
      ['details'],
      app as any,
    );

    expect(result).toEqual({ details: [{ amount: 3 }] });
    expect(getCollection).toHaveBeenCalledWith('details');
  });

  it('removes target keys at every level of a nested copy path', () => {
    const childCollection = createCollection(
      {},
      {
        filterTargetKey: 'id',
        model: { primaryKeyAttributes: ['id'], primaryKeyAttribute: 'id' },
      },
    );
    const parentCollection = createCollection(
      {
        children: { type: 'hasMany', target: 'children' },
      },
      { filterTargetKey: 'id', model: { primaryKeyAttributes: ['id'], primaryKeyAttribute: 'id' } },
    );
    const collection = createCollection(
      {
        parents: { type: 'hasMany', target: 'parents' },
      },
      {
        filterTargetKey: 'id',
        model: { primaryKeyAttributes: ['id'], primaryKeyAttribute: 'id' },
        db: {
          getCollection: (name: string) => (name === 'parents' ? parentCollection : childCollection),
        },
      },
    );
    parentCollection.db = {
      getCollection: () => childCollection,
    };

    expect(
      cleanCopyAssociationData(
        { parents: [{ id: 1, children: [{ id: 2, amount: 3 }] }] },
        { parents: [{ id: 1, children: [{ id: 2, amount: 3 }] }] },
        collection as any,
        ['parents.children'],
      ),
    ).toEqual({ parents: [{ children: [{ amount: 3 }] }] });
  });
});
