import Database, { Collection as DBCollection } from '@tego/server';
import Application from '@tego/server';

import { createApp } from '..';

describe('hasMany field options', () => {
  let db: Database;
  let app: Application;
  let Collection: DBCollection;
  let Field: DBCollection;

  beforeAll(async () => {
    app = await createApp();
    db = app.db;
    Collection = db.getCollection('collections');
    Field = db.getCollection('fields');
  });

  afterAll(async () => {
    await app.destroy();
  });

  async function createCollections(sourceName: string, targetName: string) {
    await Collection.repository.create({
      values: {
        name: sourceName,
      },
      context: {},
    });

    await Collection.repository.create({
      values: {
        name: targetName,
      },
      context: {},
    });
  }

  it('should create fields with sortable option', async () => {
    const sourceName = 'testsCreateSortable';
    const targetName = 'foosCreateSortable';
    await createCollections(sourceName, targetName);

    const field = await Field.repository.create({
      values: {
        type: 'hasMany',
        collectionName: sourceName,
        target: targetName,
        sortable: true,
        foreignKey: 'test_id',
      },
      context: {},
    });

    await field.reload();
    expect(field.get('sortable')).toBe(true);
    expect(field.get('sortBy')).toBe('test_idSort');
  });

  it('should update field with sortable option', async () => {
    const sourceName = 'testsUpdateSortable';
    const targetName = 'foosUpdateSortable';
    await createCollections(sourceName, targetName);

    const field = await Field.repository.create({
      values: {
        type: 'hasMany',
        collectionName: sourceName,
        target: targetName,
        foreignKey: 'test_id',
      },
      context: {},
    });

    await field.reload();

    expect(field.get('sortBy')).toBe(undefined);

    await Field.repository.update({
      values: {
        sortable: true,
      },
      filter: {
        key: field.get('key'),
      },
      context: {},
    });

    await field.reload();

    expect(field.get('sortBy')).toBe('test_idSort');
    const collection = db.getCollection(targetName);
    const columns = await db.sequelize.getQueryInterface().describeTable(collection.getTableNameWithSchema());
    expect(columns).toHaveProperty(collection.model.rawAttributes['test_idSort'].field);
  });

  it('should generate the foreignKey randomly', async () => {
    const sourceName = 'testsRandomForeignKey';
    const targetName = 'foosRandomForeignKey';
    await createCollections(sourceName, targetName);

    const field = await Field.repository.create({
      values: {
        type: 'hasMany',
        collectionName: sourceName,
        target: targetName,
      },
    });
    await field.reload();
    const json = field.toJSON();
    expect(json).toMatchObject({
      type: 'hasMany',
      collectionName: sourceName,
      target: targetName,
      sourceKey: 'id',
      targetKey: 'id',
    });
    expect(json.name).toBeDefined();
    expect(json.foreignKey).toBeDefined();
  });

  it('the parameters are not generated randomly', async () => {
    const sourceName = 'testsExplicitParameters';
    const targetName = 'foosExplicitParameters';
    await createCollections(sourceName, targetName);

    const field = await Field.repository.create({
      values: {
        name: 'foos',
        type: 'hasMany',
        collectionName: sourceName,
        target: targetName,
        sourceKey: 'abc',
        foreignKey: 'def',
        targetKey: 'ghi',
      },
    });
    await field.reload();
    expect(field.toJSON()).toMatchObject({
      name: 'foos',
      type: 'hasMany',
      collectionName: sourceName,
      target: targetName,
      sourceKey: 'abc',
      foreignKey: 'def',
      targetKey: 'ghi',
    });
  });
});
