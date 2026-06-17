import { MockServer } from '@tachybase/test';

import { createApp } from '..';

describe('collections.fields', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.destroy();
  });

  test('destroy field', async () => {
    const collectionName = 'testDestroyFieldWithInitialFields';

    await app
      .agent()
      .resource('collections')
      .create({
        values: {
          name: collectionName,
          fields: [
            {
              type: 'string',
              name: 'name',
            },
          ],
        },
      });

    const collection = app.db.getCollection(collectionName);
    const field = collection.getField('name');

    expect(collection.hasField('name')).toBeTruthy();

    const r1 = await field.existsInDb();
    expect(r1).toBeTruthy();

    await app.agent().resource('collections.fields', collectionName).destroy({
      filterByTk: 'name',
    });

    expect(collection.hasField('name')).toBeFalsy();

    const r2 = await field.existsInDb();
    expect(r2).toBeFalsy();
  });

  test('destroy field', async () => {
    const collectionName = 'testDestroyFieldAddedLater';

    await app
      .agent()
      .resource('collections')
      .create({
        values: {
          name: collectionName,
        },
      });
    await app
      .agent()
      .resource('collections.fields', collectionName)
      .create({
        values: {
          type: 'string',
          name: 'name',
        },
      });
    const collection = app.db.getCollection(collectionName);
    const field = collection.getField('name');
    expect(collection.hasField('name')).toBeTruthy();
    const r1 = await field.existsInDb();
    expect(r1).toBeTruthy();
    await app.agent().resource('collections.fields', collectionName).destroy({
      filterByTk: 'name',
    });
    expect(collection.hasField('name')).toBeFalsy();
    const r2 = await field.existsInDb();
    expect(r2).toBeFalsy();
  });

  test('remove association field', async () => {
    const sourceName = 'testRemoveAssociationFieldSource';
    const targetName = 'testRemoveAssociationFieldTarget';

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
    const collection = app.db.getCollection(sourceName);
    const collection2 = app.db.getCollection(targetName);
    expect(collection.hasField(targetName)).toBeTruthy();
    expect(collection2.hasField(sourceName)).toBeTruthy();
    await app.agent().resource('collections.fields', sourceName).destroy({
      filterByTk: targetName,
    });
    expect(collection.hasField(targetName)).toBeFalsy();
    expect(collection2.hasField(sourceName)).toBeTruthy();
  });
});
