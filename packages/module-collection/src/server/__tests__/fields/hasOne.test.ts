import Database, { Collection as DBCollection } from '@tego/server';
import Application from '@tego/server';

import { createApp } from '..';

describe('hasOne field options', () => {
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
    });
    await Collection.repository.create({
      values: {
        name: targetName,
      },
    });
  }

  it('should generate the foreignKey randomly', async () => {
    const sourceName = 'hasOneRandomTests';
    const targetName = 'hasOneRandomFoos';
    await createCollections(sourceName, targetName);

    const field = await Field.repository.create({
      values: {
        type: 'hasOne',
        collectionName: sourceName,
        target: targetName,
      },
    });
    const json = field.toJSON();
    // hasOne 的 sourceKey 默认为 id，foreignKey 随机生成
    expect(json).toMatchObject({
      type: 'hasOne',
      collectionName: sourceName,
      target: targetName,
      sourceKey: 'id',
    });
    expect(json.name).toBeDefined();
    expect(json.foreignKey).toBeDefined();
  });

  it('the parameters are not generated randomly', async () => {
    const sourceName = 'hasOneExplicitTests';
    const targetName = 'hasOneExplicitFoos';
    await createCollections(sourceName, targetName);

    const field = await Field.repository.create({
      values: {
        name: 'foo',
        type: 'hasOne',
        collectionName: sourceName,
        target: targetName,
        sourceKey: 'abc',
        foreignKey: 'def',
      },
    });
    expect(field.toJSON()).toMatchObject({
      name: 'foo',
      type: 'hasOne',
      collectionName: sourceName,
      target: targetName,
      sourceKey: 'abc',
      foreignKey: 'def',
    });
  });
});
