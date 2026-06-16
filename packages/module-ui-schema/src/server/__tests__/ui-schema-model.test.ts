import { createMockServer, MockServer } from '@tachybase/test';
import { Collection, Database } from '@tego/server';

import { UiSchemaRepository } from '..';

describe('ui schema model', () => {
  let app: MockServer;
  let db: Database;

  let RelatedCollection: Collection;

  afterAll(async () => {
    await app.destroy();
  });

  beforeAll(async () => {
    app = await createMockServer({
      registerActions: true,
      plugins: ['ui-schema-storage'],
    });

    db = app.db;
    RelatedCollection = db.collection({
      name: 'hasUiSchemaCollection',
      fields: [
        {
          type: 'belongsTo',
          name: 'uiSchema',
          target: 'uiSchemas',
        },
      ],
    });

    await db.sync();
  });

  function createSchema(prefix: string, rootTitle = 'root-node', childTitle = 'child1') {
    const rootUid = `${prefix}-root-uid`;
    const rootName = `${prefix}-root-node`;
    const childName = `${prefix}-child1`;

    return {
      rootUid,
      rootName,
      childName,
      schema: {
        'x-uid': rootUid,
        title: rootTitle,
        name: rootName,
        properties: {
          [childName]: {
            title: childTitle,
          },
        },
      },
    };
  }

  it('should create schema tree after ui_schema created', async () => {
    const uiSchemaRepository = db.getCollection('uiSchemas').repository as UiSchemaRepository;
    const { rootUid, rootName, childName, schema } = createSchema('create-schema-tree');

    await RelatedCollection.repository.create({
      values: {
        uiSchema: schema,
      },
    });

    const child1 = await uiSchemaRepository.findOne({
      filter: {
        name: childName,
      },
    });

    const tree = await uiSchemaRepository.getJsonSchema(rootUid);
    expect(tree).toMatchObject({
      title: 'root-node',
      properties: {
        [childName]: {
          title: 'child1',
          'x-uid': child1.get('x-uid'),
          'x-async': false,
          'x-index': 1,
        },
      },
      name: rootName,
      'x-uid': rootUid,
      'x-async': false,
    });
  });

  it('should update schema tree after ui_schema updated', async () => {
    const uiSchemaRepository = db.getCollection('uiSchemas').repository as UiSchemaRepository;
    const { rootUid, rootName, childName, schema } = createSchema('update-schema-tree');
    const newRootName = `${rootName}-updated`;

    const relatedInstance = await RelatedCollection.repository.create({
      values: {
        uiSchema: schema,
      },
    });

    const child1 = await uiSchemaRepository.findOne({
      filter: {
        name: childName,
      },
    });

    await RelatedCollection.repository.update({
      updateAssociationValues: ['uiSchema'],
      filterByTk: relatedInstance.get('id') as string,
      values: {
        uiSchema: {
          'x-uid': rootUid,
          title: 'new-root-title',
          name: newRootName,
          properties: {
            [childName]: {
              title: 'new-child1-title',
            },
          },
        },
      },
    });

    const tree = await uiSchemaRepository.getJsonSchema(rootUid);

    expect(tree).toMatchObject({
      title: 'new-root-title',
      properties: {
        [childName]: {
          title: 'new-child1-title',
          'x-uid': child1.get('x-uid'),
          'x-async': false,
          'x-index': 1,
        },
      },
      name: newRootName,
      'x-uid': rootUid,
      'x-async': false,
    });
  });
});
