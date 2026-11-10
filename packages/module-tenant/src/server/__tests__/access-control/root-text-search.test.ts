import type { Collection, Database } from '@tego/server';

import { captureRootTextSearch } from '../../access-control/root-text-search';
import { sqliteDatabase } from './database';

describe('flat root text search capture', () => {
  let db: Database;
  let collection: Collection;
  const permission = { allowed: true, params: { fields: ['id', 'name', 'stage'] } };

  beforeEach(() => {
    db = sqliteDatabase();
    collection = db.collection({
      name: 'tasks',
      timestamps: false,
      fields: [
        { name: 'name', type: 'string' },
        { name: 'stage', type: 'text' },
        { name: 'privateNote', type: 'string' },
        { name: 'payload', type: 'json' },
        { name: 'deadline', type: 'date' },
        {
          name: 'tenantId',
          type: 'context',
          dataIndex: 'state.currentTenant.id',
          dataType: 'string',
          createOnly: true,
        },
        { name: 'choice', type: 'string', uiSchema: { 'x-component': 'Select' } },
      ],
    });
  });
  afterEach(async () => {
    await db.close();
  });

  it('combines keywords with the original block filter using only final readable text fields', () => {
    const input = { keywords: [' Alpha ', '', 'Beta'] };
    const filter = { stage: 'draft' };
    expect(captureRootTextSearch(collection, permission, input, filter)).toEqual({
      $and: [
        { stage: 'draft' },
        {
          $or: [
            { name: { $includes: 'Alpha' } },
            { name: { $includes: 'Beta' } },
            { stage: { $includes: 'Alpha' } },
            { stage: { $includes: 'Beta' } },
          ],
        },
      ],
    });
    expect(input).toEqual({ keywords: [' Alpha ', '', 'Beta'] });
    expect(filter).toEqual({ stage: 'draft' });
  });

  it('searches explicitly chosen readable text fields without interpreting numeric text as an id', () => {
    expect(captureRootTextSearch(collection, permission, { keywords: ['42'], fields: ['name'] }, undefined)).toEqual({
      $or: [{ name: { $includes: '42' } }],
    });
  });

  it('keeps managed context columns out of search as the original plugin does', () => {
    expect(
      captureRootTextSearch(
        collection,
        { allowed: true, params: { fields: ['name', 'tenantId'] } },
        { keywords: ['Alpha'] },
        undefined,
      ),
    ).toEqual({ $or: [{ name: { $includes: 'Alpha' } }] });
  });

  it('keeps a blank search inert after validating explicit field access', () => {
    expect(captureRootTextSearch(collection, permission, { keywords: ['  '], fields: ['name'] }, { id: 1 })).toEqual({
      id: 1,
    });
    expect(() =>
      captureRootTextSearch(collection, permission, { keywords: [], fields: ['privateNote'] }, {}),
    ).toThrow();
  });

  it.each([
    null,
    { keywords: 'Alpha' },
    { keywords: [1] },
    { keywords: ['a'.repeat(1001)] },
    { keywords: Array(11).fill('Alpha') },
    { keywords: ['Alpha'], fields: ['privateNote'] },
    { keywords: ['Alpha'], fields: ['project.name'] },
    { keywords: ['Alpha'], fields: [] },
    { keywords: ['Alpha'], fields: ['missing'] },
    { keywords: ['Alpha'], isSearchAllFields: 'true' },
    { keywords: ['Alpha'], transaction: {} },
  ])('rejects malformed or unauthorized requests: %j', (input) => {
    expect(() => captureRootTextSearch(collection, permission, input, {})).toThrow();
  });

  it.each(['payload', 'deadline', 'choice'])('does not silently ignore unsupported %s search semantics', (name) => {
    expect(() =>
      captureRootTextSearch(collection, { allowed: true, params: { fields: [name] } }, { keywords: ['Alpha'] }, {}),
    ).toThrow();
  });

  it('rejects numeric default-field searches until their cast adapter exists', () => {
    expect(() => captureRootTextSearch(collection, permission, { keywords: ['42'] }, {})).toThrow();
  });

  it('rejects a search without an allowed operation even when all fields would match', () => {
    expect(() =>
      captureRootTextSearch(collection, { allowed: false, params: {} }, { keywords: ['Alpha'] }, {}),
    ).toThrow();
  });

  it('does not evaluate input accessors', () => {
    let reads = 0;
    const input = Object.defineProperty({}, 'keywords', {
      get() {
        reads++;
        return ['Alpha'];
      },
    });
    expect(() => captureRootTextSearch(collection, permission, input, {})).toThrow();
    expect(reads).toBe(0);
  });

  it('bounds the expanded OR instead of returning a partially searched set of fields', () => {
    const names = Array.from({ length: 11 }, (_, index) => `value${index}`);
    for (const name of names) collection.setField(name, { type: 'string' });
    expect(() =>
      captureRootTextSearch(
        collection,
        { allowed: true, params: { fields: names } },
        { keywords: Array(10).fill('Alpha') },
        {},
      ),
    ).toThrow();
  });
});
