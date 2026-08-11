import { describe, expect, it } from 'vitest';

import { getSummaryAssociationAppends, getWorkflowAppends, serializeError } from '../tools';

function createCollection(fields: Record<string, any>, targets: Record<string, any> = {}) {
  return {
    getField: (name: string) => fields[name],
    db: {
      getCollection: (name: string) => targets[name],
    },
  } as any;
}

function createSummaryCollections() {
  const products = createCollection({ name: { type: 'string' } });
  const items = createCollection(
    {
      amount: { type: 'integer' },
      product: { type: 'belongsTo', target: 'products' },
    },
    { products },
  );
  const users = createCollection({ name: { type: 'string' } });
  const root = createCollection(
    {
      items: { type: 'hasMany', target: 'items' },
      owner: { type: 'belongsTo', target: 'users' },
      total: { type: 'integer' },
      unresolved: { type: 'hasOne', target: 'missing' },
    },
    { items, users },
  );

  return root;
}

describe('serializeError', () => {
  it('serializes a standard Error instance', () => {
    const error = new Error('known failure');
    error.name = 'KnownError';

    expect(serializeError(error)).toEqual({
      name: 'KnownError',
      message: 'known failure',
      stack: error.stack,
    });
  });

  it('uses a stable message when an object cannot be converted to a string', () => {
    const error = Object.assign(Object.create(null), { message: 42 });

    expect(serializeError(error)).toEqual({
      name: undefined,
      message: 'Unknown error',
      stack: undefined,
    });
  });

  it('safely serializes a proxy whose properties throw', () => {
    const error = new Proxy(
      {},
      {
        get() {
          throw new Error('property access failed');
        },
      },
    );

    expect(serializeError(error)).toEqual({
      name: undefined,
      message: 'Unknown error',
      stack: undefined,
    });
  });
});

describe('workflow appends', () => {
  it('collects nested summary associations and stops at non-association or unresolved fields', () => {
    const collection = createSummaryCollections();

    expect(
      getSummaryAssociationAppends(['items.product.name', 'items.amount', 'total', 'unresolved.value'], collection),
    ).toEqual(['items', 'items.product']);
  });

  it('merges explicit and summary appends without duplicates', () => {
    const collection = createSummaryCollections();

    expect(
      getWorkflowAppends(
        {
          appends: ['owner', 'items', 'owner'],
          summary: ['items.product.name', 'owner.name'],
        },
        collection,
      ),
    ).toEqual(['owner', 'items', 'items.product']);
  });

  it('drops explicit appends whose association path is no longer available', () => {
    const collection = createSummaryCollections();

    expect(
      getWorkflowAppends(
        {
          appends: ['owner.positions', 'owner', 'missing'],
          summary: [],
        },
        collection,
      ),
    ).toEqual(['owner']);
  });
});
