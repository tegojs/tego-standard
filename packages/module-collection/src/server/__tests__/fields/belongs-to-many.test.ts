import Database, { Collection as DBCollection } from '@tego/server';
import Application from '@tego/server';

import { createApp } from '..';

describe('belongsToMany', () => {
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

  async function createPostTagCollections(sourceName: string, targetName: string) {
    await Collection.repository.create({
      values: {
        name: sourceName,
        fields: [{ type: 'string', name: 'title' }],
      },
      context: {},
    });

    await Collection.repository.create({
      values: {
        name: targetName,
        fields: [{ type: 'string', name: 'name' }],
      },
      context: {},
    });
  }

  it('should check association keys', async () => {
    const sourceName = 'postsAssociationKeys';
    const targetName = 'tagsAssociationKeys';
    const throughName = 'postsTagsAssociationKeys';
    await createPostTagCollections(sourceName, targetName);

    await Collection.repository.create({
      values: {
        name: throughName,
        fields: [
          {
            type: 'string',
            name: 'postId',
          },
          {
            type: 'string',
            name: 'tagId',
          },
        ],
      },
      context: {},
    });

    let error;
    try {
      await Field.repository.create({
        values: {
          collectionName: sourceName,
          type: 'belongsToMany',
          name: 'tags',
          target: targetName,
          through: throughName,
          sourceKey: 'id',
          targetKey: 'id',
          foreignKey: 'postId',
          otherKey: 'tagId',
        },
        context: {},
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
  });

  it('should throw error when through table foreign keys are same name', async () => {
    const sourceName = 'sameForeignKeyA';
    const targetName = 'sameForeignKeyB';

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

    let error;

    try {
      await Field.repository.create({
        values: {
          name: 'bs',
          type: 'belongsToMany',
          collectionName: sourceName,
          target: targetName,
          sourceKey: 'id',
          targetKey: 'id',
          foreignKey: 'a_id',
          otherKey: 'a_id',
        },
        context: {},
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
  });

  it('should define belongs to many when change alias name', async () => {
    const sourceName = 'aliasSource';
    const targetName = 'aliasTarget';
    const throughName = 'aliasThrough';

    await Collection.repository.create({
      values: {
        name: sourceName,
        fields: [{ type: 'bigInt', name: 'id', primaryKey: true, autoIncrement: true }],
      },
      context: {},
    });

    await Collection.repository.create({
      values: {
        name: targetName,
        fields: [{ type: 'bigInt', name: 'id', primaryKey: true, autoIncrement: true }],
      },
      context: {},
    });

    await Collection.repository.create({
      values: {
        name: throughName,
        fields: [{ type: 'bigInt', name: 'id', primaryKey: true, autoIncrement: true }],
      },
      context: {},
    });

    let error;
    try {
      await Field.repository.create({
        values: {
          name: throughName,
          type: 'belongsToMany',
          target: targetName,
          through: throughName,
          collectionName: sourceName,
          sourceKey: 'id',
          targetKey: 'id',
          foreignKey: 'a_id',
          otherKey: 'b_id',
        },
        context: {},
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();

    let error2;
    try {
      await Field.repository.create({
        values: {
          name: 'xxx',
          type: 'belongsToMany',
          target: targetName,
          through: throughName,
          collectionName: sourceName,
          sourceKey: 'id',
          targetKey: 'id',
          foreignKey: 'a_id',
          otherKey: 'b_id',
        },
        context: {},
      });
    } catch (e) {
      error2 = e;
    }

    expect(error2).not.toBeDefined();
  });

  it('should create belongsToMany field', async () => {
    const sourceName = 'postsCreateBelongsToMany';
    const targetName = 'tagsCreateBelongsToMany';
    const throughName = 'postsCreateBelongsToManyTags';
    await createPostTagCollections(sourceName, targetName);

    await Field.repository.create({
      values: {
        name: 'tags',
        type: 'belongsToMany',
        collectionName: sourceName,
        interface: 'm2m',
        target: targetName,
        through: throughName,
      },
      context: {},
    });

    const throughCollection = await Collection.repository.findOne({
      filter: {
        name: throughName,
      },
    });

    expect(throughCollection.get('sortable')).toEqual(false);
    const collectionManagerSchema = process.env.COLLECTION_MANAGER_SCHEMA;
    const mainSchema = db.options.schema || 'public';

    if (collectionManagerSchema && mainSchema !== collectionManagerSchema && db.inDialect('postgres')) {
      expect(throughCollection.get('schema')).toEqual(collectionManagerSchema);

      const tableName = db.getCollection(throughName).model.tableName;

      const mainSchema = db.options.schema || 'public';

      const tableExists = async (tableName: string, schema: string) => {
        const sql = `SELECT EXISTS(SELECT 1 FROM information_schema.tables
                 WHERE  table_schema = '${schema}'
                 AND    table_name   = '${tableName}')`;

        const results = await db.sequelize.query(sql, { type: 'SELECT' });

        const exists = results[0]['exists'];
        return exists;
      };

      expect(await tableExists(tableName, collectionManagerSchema)).toBe(true);
      expect(await tableExists(tableName, mainSchema)).toBe(false);
    }
  });

  it('should belongs to many fields after through collection destroyed', async () => {
    const sourceName = 'postsDestroyThrough';
    const targetName = 'tagsDestroyThrough';
    const throughName = 'postsDestroyThroughTags';
    await createPostTagCollections(sourceName, targetName);

    await Field.repository.create({
      values: {
        name: 'tags',
        type: 'belongsToMany',
        collectionName: sourceName,
        interface: 'm2m',
        target: targetName,
        through: throughName,
      },
      context: {},
    });

    const throughCollection = await Collection.repository.findOne({
      filter: {
        name: throughName,
      },
    });

    await db.getRepository(sourceName).create({
      values: [
        {
          title: 'p1',
          tags: [{ name: 't1' }],
        },
        {
          title: 'p2',
          tags: [{ name: 't2' }],
        },
      ],
    });

    await throughCollection.destroy();

    expect(
      await Field.repository.count({
        filter: {
          name: 'tags',
          collectionName: sourceName,
        },
      }),
    ).toEqual(0);
  });
});
