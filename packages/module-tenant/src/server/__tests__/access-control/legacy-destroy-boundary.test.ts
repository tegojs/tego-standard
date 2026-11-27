import type { Database } from '@tego/server';

import { assertLegacyDestroyBoundary } from '../../access-control/legacy-write-boundary';
import { sqliteDatabase } from './database';

describe('legacy deletion write locations', () => {
  let db: Database;

  beforeEach(() => {
    db = sqliteDatabase();
    for (const name of ['parents', 'children', 'leaves'])
      db.collection({ name, timestamps: false, fields: [{ name: 'name', type: 'string' }] });
  });

  afterEach(async () => {
    await db.close();
  });

  function reference(source: string, target: string, onDelete: string) {
    db.getCollection(source).setField('parent', { type: 'belongsTo', target, foreignKey: 'parentId', onDelete });
  }

  it.each(['NO ACTION', 'RESTRICT'])('retains the core %s path without treating a reference as a write', (onDelete) => {
    reference('children', 'parents', onDelete);
    expect(() =>
      assertLegacyDestroyBoundary(db, db.getCollection('parents'), (collection) => collection.name === 'children'),
    ).not.toThrow();
  });

  it('does not follow a SET NULL update as though its target were also deleted', () => {
    reference('children', 'parents', 'SET NULL');
    reference('leaves', 'children', 'CASCADE');
    expect(() =>
      assertLegacyDestroyBoundary(db, db.getCollection('parents'), (collection) => collection.name === 'leaves'),
    ).not.toThrow();
  });

  it('terminates an unselected cascade cycle and still checks every reachable write location', () => {
    reference('children', 'parents', 'CASCADE');
    reference('parents', 'children', 'CASCADE');
    reference('leaves', 'children', 'SET NULL');
    expect(() => assertLegacyDestroyBoundary(db, db.getCollection('parents'), () => false)).not.toThrow();
    expect(() =>
      assertLegacyDestroyBoundary(db, db.getCollection('parents'), (collection) => collection.name === 'leaves'),
    ).toThrow('Legacy cascaded writes');
  });

  it('does not inspect an unrelated selected collection', () => {
    reference('children', 'parents', 'CASCADE');
    expect(() =>
      assertLegacyDestroyBoundary(db, db.getCollection('parents'), (collection) => collection.name === 'leaves'),
    ).not.toThrow();
  });
});
