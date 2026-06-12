import Database, { Collection as DBCollection, uid } from '@tego/server';
import Application from '@tego/server';

import { createApp } from '..';

describe('destroy', () => {
  let db: Database;
  let app: Application;
  let Collection: DBCollection;
  let Field: DBCollection;

  beforeAll(async () => {
    app = await createApp({
      database: {
        tablePrefix: '',
      },
    });
    db = app.db;
    Collection = db.getCollection('collections');
    Field = db.getCollection('fields');
  });

  afterAll(async () => {
    await app.destroy();
  });

  async function createCollectionsForForeignKeyDestroy(sourceName: string, targetName: string) {
    await Collection.repository.create({
      values: {
        name: sourceName,
        fields: [
          {
            name: 'name',
            type: 'string',
          },
        ],
      },
      context: {},
    });

    await Collection.repository.create({
      values: {
        name: targetName,
        fields: [
          {
            name: 'name',
            type: 'string',
          },
        ],
      },
      context: {},
    });
  }

  describe('destroy field', () => {
    it('should remove field in model when field destroyed', async () => {
      const collectionName = `destroyFieldTest_${uid()}`;
      const collection = await Collection.repository.create({
        values: {
          name: collectionName,
          fields: [
            { name: 'f1', type: 'string' },
            {
              name: 'name',
              type: 'string',
            },
          ],
        },
        context: {},
      });

      expect(db.getCollection(collectionName).model.rawAttributes.name).toBeDefined();

      await Field.repository.destroy({
        filter: {
          name: 'name',
          collectionName,
        },
        context: {},
      });

      expect(db.getCollection(collectionName).model.rawAttributes.name).toBeUndefined();
      expect(db.getCollection(collectionName).model.rawAttributes.f1).toBeDefined();
    });
  });

  describe('destroy foreign key', () => {
    it('should destroy association field when foreign key field destroyed', async () => {
      const sourceName = 'foreignKeyDestroyA';
      const targetName = 'foreignKeyDestroyB';
      await createCollectionsForForeignKeyDestroy(sourceName, targetName);

      await Field.repository.create({
        values: {
          name: targetName,
          type: 'hasOne',
          target: targetName,
          collectionName: sourceName,
          foreignKey: 'a_id',
          interface: 'oho',
        },
        context: {},
      });

      // should create association field
      expect(
        await Field.repository.findOne({
          filter: {
            collectionName: sourceName,
            name: targetName,
          },
        }),
      ).toBeTruthy();

      const foreignKeyField = await Field.repository.findOne({
        filter: {
          name: 'a_id',
          collectionName: targetName,
        },
      });

      // should create foreign key
      expect(foreignKeyField).toBeTruthy();

      expect(db.getCollection(targetName).model.rawAttributes.a_id).toBeTruthy();

      // destroy foreign key field
      await Field.repository.destroy({
        filter: {
          name: 'a_id',
          collectionName: targetName,
        },
        context: {},
      });

      // should remove association field
      expect(
        await Field.repository.findOne({
          filter: {
            collectionName: sourceName,
            name: targetName,
          },
        }),
      ).toBeFalsy();

      // should remove foreign key
      expect(db.getCollection(targetName).model.rawAttributes.a_id).toBeFalsy();
    });
  });
});
