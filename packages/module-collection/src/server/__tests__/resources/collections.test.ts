import { MockServer } from '@tachybase/test';
import { HasManyRepository } from '@tego/server';

import { createApp } from '..';

describe('collections', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.destroy();
  });

  test('remove collection with cascade options', async () => {
    const collectionName = 'testRemoveCollectionCascade';
    const viewName = 'testRemoveCollectionCascadeView';

    await app
      .agent()
      .resource('collections')
      .create({
        values: {
          name: collectionName,
        },
      });
    const collection = app.db.getCollection(collectionName);
    expect(await collection.existsInDb()).toBeTruthy();

    // create a database view for test
    await app.db.sequelize.query(`
      CREATE VIEW ${viewName} AS SELECT * FROM ${collection.getTableNameWithSchemaAsString()};
    `);

    await app.agent().resource('collections').destroy({
      filterByTk: collectionName,
      cascade: true,
    });

    expect(await collection.existsInDb()).toBeFalsy();
  });

  test('remove collection 1', async () => {
    const collectionName = 'testRemoveCollection1';

    await app
      .agent()
      .resource('collections')
      .create({
        values: {
          name: collectionName,
        },
      });
    const collection = app.db.getCollection(collectionName);
    expect(await collection.existsInDb()).toBeTruthy();
    await app.agent().resource('collections').destroy({
      filterByTk: collectionName,
    });

    expect(await collection.existsInDb()).toBeFalsy();
  });

  test('remove collection 2', async () => {
    const sourceName = 'testRemoveCollection2Source';
    const targetName = 'testRemoveCollection2Target';

    await app
      .agent()
      .resource('collections')
      .create({
        values: {
          name: sourceName,
        },
      });
    await app
      .agent()
      .resource('collections')
      .create({
        values: {
          name: targetName,
        },
      });
    await app
      .agent()
      .resource('collections.fields', sourceName)
      .create({
        values: {
          type: 'belongsTo',
          name: targetName,
          target: targetName,
          reverseField: {
            name: sourceName,
          },
        },
      });
    await app.agent().resource('collections').destroy({
      filterByTk: sourceName,
    });
    expect(app.db.hasCollection(sourceName)).toBeFalsy();
    expect(!!app.db.sequelize.modelManager.getModel(sourceName)).toBeFalsy();
    const collection2 = app.db.getCollection(targetName);
    expect(collection2.hasField(targetName)).toBeFalsy();
    const count = await app.db.getRepository<HasManyRepository>('collections.fields', targetName).count({
      filter: {
        name: targetName,
      },
    });
    expect(count).toBe(0);
  });

  test('remove collection 3', async () => {
    const sourceName = 'testRemoveCollection3Source';
    const targetName = 'testRemoveCollection3Target';
    const throughName = 'testRemoveCollection3Through';

    await app
      .agent()
      .resource('collections')
      .create({
        values: {
          name: sourceName,
        },
      });
    await app
      .agent()
      .resource('collections')
      .create({
        values: {
          name: targetName,
        },
      });
    await app
      .agent()
      .resource('collections')
      .create({
        values: {
          name: throughName,
        },
      });
    await app
      .agent()
      .resource('collections.fields', sourceName)
      .create({
        values: {
          type: 'belongsToMany',
          name: targetName,
          target: targetName,
          through: throughName,
          reverseField: {
            name: sourceName,
          },
        },
      });
    await app.agent().resource('collections').destroy({
      filterByTk: throughName,
    });
    expect(app.db.hasCollection(throughName)).toBeFalsy();
    expect(!!app.db.sequelize.modelManager.getModel(throughName)).toBeFalsy();
    const collection1 = app.db.getCollection(sourceName);
    expect(collection1.hasField(targetName)).toBeFalsy();
    const collection2 = app.db.getCollection(targetName);
    expect(collection2.hasField(sourceName)).toBeFalsy();
  });
});
