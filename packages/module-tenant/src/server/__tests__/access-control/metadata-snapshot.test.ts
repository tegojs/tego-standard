import type { Database } from '@tego/server';

import { accessMetadataGuard } from '../../access-control/metadata-snapshot';
import { sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

describe('access metadata dependencies', () => {
  let db: Database;

  beforeEach(() => {
    db = sqliteDatabase();
    for (const name of ['documents', 'children', 'tenants', 'tags', 'links', 'unrelated'])
      db.collection({
        name,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'tenantId', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'sourceId', type: 'integer' },
          { name: 'targetId', type: 'integer' },
        ],
      });
    db.getCollection('documents').setField('children', { type: 'hasMany', target: 'children', foreignKey: 'sourceId' });
    db.getCollection('children').setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'targetId' });
    db.getCollection('children').setField('tags', {
      type: 'belongsToMany',
      target: 'tags',
      through: 'links',
      foreignKey: 'sourceId',
      otherKey: 'targetId',
    });
  });
  afterEach(async () => {
    await db.close();
  });

  const guard = (path = 'children.owner') =>
    accessMetadataGuard(db, [
      {
        model: db.getCollection('documents').model,
        config: configFor({ type: 'exists', path, condition: { type: 'constant', value: true } }, 'visibility'),
      },
    ]);

  it('captures nested rule dependencies without scanning unrelated collections', () => {
    const unrelated = db.getCollection('unrelated').model;
    const spy = vi.spyOn(unrelated, 'getTableName').mockImplementation(() => {
      throw Error('Unrelated model visited');
    });
    const verify = guard();
    unrelated.rawAttributes.name.field = 'Changed';
    expect(verify).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
  it('rejects in-place column changes on a third model used by a rule', () => {
    const verify = guard();
    db.getCollection('tenants').model.rawAttributes.name.field = 'tenantId';
    expect(verify).toThrow('metadata changed');
  });
  it('rejects nested association replacement', () => {
    const verify = guard();
    db.getCollection('children').setField('owner', { type: 'belongsTo', target: 'tenants', foreignKey: 'targetId' });
    expect(verify).toThrow('metadata changed');
  });
  it('rejects a replaced collection model', () => {
    const verify = guard();
    db.getCollection('tenants').model = db.getCollection('unrelated').model;
    expect(verify).toThrow('metadata changed');
  });
  it('captures association scopes and keys as well as model columns', () => {
    const verify = guard();
    const relation = db.getCollection('children').model.associations.owner as unknown as { scope: object };
    relation.scope = { name: 'Changed' };
    expect(verify).toThrow('metadata changed');
  });
  it('captures through-table metadata for relational many-to-many rules', () => {
    const verify = guard('children.tags');
    db.getCollection('links').model.rawAttributes.sourceId.field = 'targetId';
    expect(verify).toThrow('metadata changed');
  });
  it('captures through-scope changes', () => {
    const verify = guard('children.tags');
    const relation = db.getCollection('children').model.associations.tags as unknown as { through: { scope: object } };
    relation.through.scope = { name: 'Changed' };
    expect(verify).toThrow('metadata changed');
  });
  it('captures relational subjects under logical groups', () => {
    const config = configFor(ownerCondition);
    config.rules[0].subject = {
      type: 'all',
      children: [
        {
          type: 'not',
          child: {
            type: 'any',
            children: [{ type: 'exists', path: 'children.owner', condition: { type: 'constant', value: true } }],
          },
        },
      ],
    };
    const verify = accessMetadataGuard(db, [{ model: db.getCollection('documents').model, config }]);
    db.getCollection('tenants').model.addScope('defaultScope', { where: { name: 'Changed' } }, { override: true });
    expect(verify).toThrow('metadata changed');
  });
});
