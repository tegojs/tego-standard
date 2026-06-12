import ModuleUiSchema, { UiSchemaRepository } from '@tachybase/plugin-ui-schema-storage';
import { createMockServer, MockServer } from '@tachybase/test';
import { Database } from '@tego/server';

import { vi } from 'vitest';

describe('server hooks', () => {
  let app: MockServer;
  let db: Database;
  let uiSchemaRepository: UiSchemaRepository;
  let uiSchemaPlugin: ModuleUiSchema;

  const createCollectionHookSchema = (rootUid: string, collectionName: string, fieldName: string, method: string) => ({
    'x-uid': rootUid,
    name: rootUid,
    properties: {
      row: {
        'x-uid': `${rootUid}-table`,
        'x-component': 'Table',
        'x-collection': collectionName,
        'x-server-hooks': [
          {
            type: 'onCollectionDestroy',
            collection: collectionName,
            method,
          },
        ],
        properties: {
          col1: {
            'x-uid': `${rootUid}-col1`,
            'x-component': 'Col',
            properties: {
              field1: {
                'x-uid': `${rootUid}-field1`,
                'x-component': 'Input',
                'x-collection-field': `${collectionName}.${fieldName}`,
                'x-server-hooks': [
                  {
                    type: 'onCollectionFieldDestroy',
                    collection: collectionName,
                    field: fieldName,
                    method,
                  },
                ],
              },
            },
          },
        },
      },
    },
  });

  afterAll(async () => {
    await app.destroy();
  });

  beforeAll(async () => {
    app = await createMockServer({
      registerActions: true,
      plugins: ['ui-schema-storage', 'collection-manager', 'error-handler'],
    });

    db = app.db;

    uiSchemaRepository = db.getRepository('uiSchemas');

    uiSchemaPlugin = app.getPlugin<ModuleUiSchema>('ui-schema-storage');
  });

  it('should call server hooks onFieldDestroy', async () => {
    const collectionName = 'serverHookFieldPosts';
    const fieldName = 'title';
    const methodName = 'onFieldDestroyForFieldTest';
    await uiSchemaRepository.insert(
      createCollectionHookSchema('server-hook-field-root', collectionName, fieldName, methodName),
    );

    const PostModel = await db.getRepository('collections').create({
      values: {
        name: collectionName,
      },
    });

    const fieldModel = await db.getRepository('fields').create({
      values: {
        name: fieldName,
        type: 'string',
        collectionName,
      },
    });

    // @ts-ignore
    await PostModel.migrate();

    const serverHooks = uiSchemaPlugin.serverHooks;
    const hookFn = vi.fn();

    serverHooks.register('onCollectionFieldDestroy', methodName, hookFn);

    // destroy a field
    await db.getRepository('fields').destroy({
      filter: {
        name: fieldName,
      },
      individualHooks: true,
    });

    expect(hookFn).toHaveBeenCalled();
  });

  it('should call server hooks onCollectionDestroy', async () => {
    const collectionName = 'serverHookCollectionPosts';
    const fieldName = 'title';
    const methodName = 'onCollectionDestroyForCollectionTest';
    await uiSchemaRepository.insert(
      createCollectionHookSchema('server-hook-collection-root', collectionName, fieldName, methodName),
    );

    const PostModel = await db.getRepository('collections').create({
      values: {
        name: collectionName,
      },
    });

    const fieldModel = await db.getRepository('fields').create({
      values: {
        name: fieldName,
        type: 'string',
        collectionName,
      },
    });

    // @ts-ignore
    await PostModel.migrate();

    const serverHooks = uiSchemaPlugin.serverHooks;

    const hookFn = vi.fn();

    serverHooks.register('onCollectionDestroy', methodName, hookFn);

    // destroy a field
    await db.getRepository('collections').destroy({
      filter: {
        name: collectionName,
      },
      individualHooks: true,
    });

    expect(hookFn).toHaveBeenCalled();
  });

  it('should call server hooks onUiSchemaCreate', async () => {
    const menuUid = 'server-hook-menu-create';
    const methodName = 'afterCreateMenuForCreateTest';
    const menuSchema = {
      'x-uid': menuUid,
      'x-server-hooks': [
        {
          type: 'onSelfCreate',
          method: methodName,
        },
      ],
    };

    const serverHooks = uiSchemaPlugin.serverHooks;
    const hookFn = vi.fn();

    serverHooks.register('onSelfCreate', methodName, hookFn);

    await uiSchemaRepository.insert(menuSchema);

    expect(hookFn).toHaveBeenCalled();
  });

  it('should call server hooks onAnyCollectionFieldDestroy', async () => {
    const collectionName = 'serverHookAnyPosts';
    const fieldName = 'title';
    const methodName = 'testAnyCollectionFieldDestroy';
    const menuSchema = {
      'x-uid': 'server-hook-any-menu',
      'x-server-hooks': [
        {
          type: 'onAnyCollectionFieldDestroy',
          collection: collectionName,
          method: methodName,
        },
      ],
    };

    await uiSchemaRepository.insert(menuSchema);

    const PostModel = await db.getRepository('collections').create({
      values: {
        name: collectionName,
      },
    });

    const fieldModel = await db.getRepository('fields').create({
      values: {
        name: fieldName,
        type: 'string',
        collectionName,
      },
    });

    // @ts-ignore
    await PostModel.migrate();

    const serverHooks = uiSchemaPlugin.serverHooks;
    const hookFn = vi.fn();

    serverHooks.register('onAnyCollectionFieldDestroy', methodName, hookFn);

    // destroy a field
    await db.getRepository('fields').destroy({
      filter: {
        name: fieldName,
      },
      individualHooks: true,
    });

    expect(hookFn).toHaveBeenCalled();
  });

  it('should rollback after throw error', async () => {
    const collectionName = 'serverHookRollbackPosts';
    const fieldName = 'title';
    const methodName = 'preventDestroyForRollbackTest';
    const testSchema = {
      'x-uid': 'server-hook-rollback-test',
      'x-collection-field': `${collectionName}.${fieldName}`,
      'x-server-hooks': [
        {
          type: 'onCollectionFieldDestroy',
          collection: collectionName,
          field: fieldName,
          method: methodName,
        },
      ],
    };

    await uiSchemaRepository.create({
      values: {
        schema: testSchema,
      },
    });

    const PostModel = await db.getRepository('collections').create({
      values: {
        name: collectionName,
      },
    });

    const fieldModel = await db.getRepository('fields').create({
      values: {
        name: fieldName,
        type: 'string',
        collectionName,
      },
    });

    // @ts-ignore
    await PostModel.migrate();

    const serverHooks = uiSchemaPlugin.serverHooks;

    const jestFn = vi.fn();

    serverHooks.register('onCollectionFieldDestroy', methodName, async ({ options }) => {
      await options.transaction.rollback();
      jestFn();
      throw new Error('cant delete field');
    });

    await expect(
      db.getRepository('fields').destroy({
        filter: {
          name: fieldName,
        },
        individualHooks: true,
      }),
    ).rejects.toThrow('Transaction cannot be rolled back');

    expect(jestFn).toHaveBeenCalled();
    expect(
      await db.getRepository('fields').findOne({
        filter: {
          name: fieldName,
        },
      }),
    ).toBeDefined();
  });

  it('should call onSelfMove', async () => {
    const rootUid = 'server-hook-self-move-A';
    const targetUid = 'server-hook-self-move-D';
    const methodName = 'testOnSelfMoveForMoveTest';
    const schema = {
      'x-uid': rootUid,
      name: rootUid,
      properties: {
        B: {
          'x-uid': 'server-hook-self-move-B',
          properties: {
            C: {
              'x-uid': 'server-hook-self-move-C',
              properties: {
                D: {
                  'x-uid': targetUid,
                  'x-server-hooks': [
                    {
                      type: 'onSelfMove',
                      method: methodName,
                    },
                  ],
                },
              },
            },
          },
        },
        E: {
          'x-uid': 'server-hook-self-move-E',
        },
      },
    };

    const serverHooks = uiSchemaPlugin.serverHooks;

    const jestFn = vi.fn();

    serverHooks.register('onSelfMove', methodName, async ({ options }) => {
      jestFn();
    });

    await uiSchemaRepository.insert(schema);

    await uiSchemaRepository.insertAdjacent(
      'afterEnd',
      'server-hook-self-move-E',
      {
        'x-uid': targetUid,
      },
      {
        removeParentsIfNoChildren: true,
        wrap: {
          'x-uid': 'server-hook-self-move-F',
          name: 'server-hook-self-move-F',
          properties: {
            G: {
              'x-uid': 'server-hook-self-move-G',
            },
          },
        },
      },
    );

    expect(jestFn).toHaveBeenCalled();
  });
});
