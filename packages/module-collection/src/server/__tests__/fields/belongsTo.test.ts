import Database, { Collection as DBCollection, uid } from '@tego/server';
import Application from '@tego/server';

import { createApp } from '..';
import { CollectionRepository } from '../../index';

describe('belongsTo', () => {
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

  it('should check belongs to association keys', async () => {
    const suffix = uid();
    const postCollectionName = `belongsToKeyCheckPosts_${suffix}`;
    const tagCollectionName = `belongsToKeyCheckTags_${suffix}`;
    const Post = await Collection.repository.create({
      values: {
        name: postCollectionName,
        fields: [
          {
            type: 'string',
            name: 'name',
          },
          {
            type: 'bigInt',
            name: 'postId',
          },
        ],
      },
      context: {},
    });

    const Tag = await Collection.repository.create({
      values: {
        name: tagCollectionName,
        fields: [
          {
            type: 'string',
            name: 'name',
          },
        ],
      },
      context: {},
    });

    let error;
    try {
      await Field.repository.create({
        values: {
          collectionName: postCollectionName,
          type: 'belongsTo',
          name: 'tags',
          target: tagCollectionName,
          targetKey: 'name',
          foreignKey: 'postId',
        },
        context: {},
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toContain(
      'Foreign key "postId" type "BIGINT" does not match target key "name" type "STRING"',
    );
  });
  it('should load belongsTo field', async () => {
    const suffix = uid();
    const orderCollectionName = `belongsToLoadOrders_${suffix}`;
    const userCollectionName = `belongsToLoadUsers_${suffix}`;
    await Collection.repository.create({
      values: {
        name: orderCollectionName,
        fields: [
          {
            type: 'integer',
            name: 'amount',
          },
          {
            type: 'belongsTo',
            name: userCollectionName,
            targetKey: 'uid',
            foreignKey: 'userId',
          },
        ],
      },
    });

    await Collection.repository.create({
      values: {
        name: userCollectionName,
        fields: [
          {
            type: 'string',
            name: 'name',
          },
          {
            type: 'string',
            name: 'uid',
          },
        ],
      },
    });

    let error;

    try {
      await db.getRepository<CollectionRepository>('collections').load();
    } catch (e) {
      error = e;
    }

    expect(error).toBeUndefined();
  });
});
