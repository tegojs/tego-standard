import { MockServer } from '@tachybase/test';
import Database, { Collection as DBCollection } from '@tego/server';

import { createApp } from '..';

describe('reverseField options', () => {
  let db: Database;
  let app: MockServer;
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

  it('reverseField', async () => {
    const sourceName = 'reverseFieldTests';
    const targetName = 'reverseFieldTargets';
    await createCollections(sourceName, targetName);

    const field = await Field.repository.create({
      values: {
        type: 'hasMany',
        collectionName: sourceName,
        target: targetName,
        reverseField: {},
      },
    });

    const json = JSON.parse(JSON.stringify(field.toJSON()));
    expect(json).toMatchObject({
      type: 'hasMany',
      collectionName: sourceName,
      target: targetName,
      targetKey: 'id',
      sourceKey: 'id',
      reverseField: {
        type: 'belongsTo',
        collectionName: targetName,
        target: sourceName,
        targetKey: 'id',
        sourceKey: 'id',
      },
    });
    expect(json.foreignKey).toBe(json.reverseField.foreignKey);
  });

  it('should sync onDelete options for reverse field', async () => {
    const sourceName = 'reverseOnDeleteTests';
    const targetName = 'reverseOnDeleteTargets';
    await createCollections(sourceName, targetName);

    const field = await Field.repository.create({
      values: {
        type: 'hasMany',
        collectionName: sourceName,
        target: targetName,
        onDelete: 'CASCADE',
        reverseField: {},
      },
    });

    const { reverseField } = field.toJSON();

    expect(reverseField.onDelete).toBe('CASCADE');
  });

  it('should update reverseField onDelete options', async () => {
    const sourceName = 'reverseUpdateOnDeleteTests';
    const targetName = 'reverseUpdateOnDeleteTargets';
    await createCollections(sourceName, targetName);

    const field = await Field.repository.create({
      values: {
        type: 'hasMany',
        collectionName: sourceName,
        target: targetName,
        onDelete: 'CASCADE',
        reverseField: {},
      },
    });

    const { reverseField } = field.toJSON();

    await Field.repository.update({
      filterByTk: reverseField.key,
      values: {
        onDelete: 'SET NULL',
      },
    });

    const mainField = await Field.repository.findOne({
      filterByTk: field.get('key'),
    });

    expect(mainField.get('onDelete')).toBe('SET NULL');
  });

  it('should update reverseField', async () => {
    const sourceName = 'reverseUpdateTests';
    const targetName = 'reverseUpdateTargets';
    await createCollections(sourceName, targetName);

    const field = await Field.repository.create({
      values: {
        type: 'hasMany',
        collectionName: sourceName,
        target: targetName,
        reverseField: {},
      },
    });

    expect(
      await Field.repository.count({
        filter: {
          collectionName: targetName,
        },
      }),
    ).toEqual(1);

    let reverseField = await Field.repository.findOne({
      filter: {
        collectionName: targetName,
      },
    });

    let err;

    try {
      await Field.repository.update({
        filterByTk: field.get('key') as string,
        values: {
          reverseField: {
            uiSchema: {
              title: '123',
            },
          },
        },
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();

    await Field.repository.update({
      filterByTk: field.get('key') as string,
      updateAssociationValues: ['reverseField'],
      values: {
        reverseField: {
          key: reverseField.get('key'),
          uiSchema: {
            title: '123',
          },
        },
      },
    });

    expect(
      await Field.repository.count({
        filter: {
          collectionName: targetName,
        },
      }),
    ).toEqual(1);

    reverseField = await db.getRepository('fields').findOne({
      filter: {
        key: reverseField.get('key'),
      },
    });

    const uiSchema = reverseField.get('uiSchema');
    expect(uiSchema).toEqual({ title: '123' });
  });

  it('should update uiSchema', async () => {
    const collectionName = 'reverseUiSchemaCollection';
    const fieldName = 'f_i02fjvduwmv';

    await app
      .agent()
      .resource('collections')
      .create({
        values: {
          name: collectionName,
        },
      });

    const f = await app
      .agent()
      .resource('collections.fields', collectionName)
      .create({
        values: {
          name: fieldName,
          interface: 'input',
          type: 'string',
          uiSchema: { type: 'string', 'x-component': 'Input', title: 'A1' },
        },
      });

    await app
      .agent()
      .resource('collections.fields', collectionName)
      .update({
        filterByTk: fieldName,
        values: {
          ...f.body.data,
          uiSchema: {
            ...f.body.data.uiSchema,
            title: 'A2',
          },
        },
      });

    const f2 = await app.agent().resource('collections.fields', collectionName).get({
      filterByTk: fieldName,
    });

    expect(f2.body.data.uiSchema.title).toBe('A2');
  });

  it('should create reverseField uiSchema', async () => {
    const sourceName = 'reverseFieldUiSchemaA';
    const targetName = 'reverseFieldUiSchemaB';

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
          foreignKey: 'f_qnt8iaony6i',
          onDelete: 'SET NULL',
          reverseField: {
            uiSchema: {
              title: 'A',
              'x-component': 'RecordPicker',
              'x-component-props': { multiple: false, fieldNames: { label: 'id', value: 'id' } },
            },
            interface: 'obo',
            type: 'belongsTo',
            name: 'f_dctw6v5gsio',
          },
          name: 'f_d5ebrb4h85m',
          type: 'hasOne',
          uiSchema: {
            'x-component': 'RecordPicker',
            'x-component-props': { multiple: false, fieldNames: { label: 'id', value: 'id' } },
            title: 'B',
          },
          interface: 'oho',
          target: targetName,
        },
      });

    const f1 = await app.agent().resource('collections.fields', targetName).get({
      filterByTk: 'f_dctw6v5gsio',
    });

    expect(f1.body.data.uiSchema.title).toBe('A');
  });
});
