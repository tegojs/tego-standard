import { describe, expect, it, vi } from 'vitest';

import { cleanCopyAssociationData } from '../copyAssociations';

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
});
