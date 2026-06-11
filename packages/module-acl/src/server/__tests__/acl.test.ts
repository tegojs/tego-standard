import { MockServer } from '@tachybase/test';
import { ACL, Database, uid } from '@tego/server';

import { aclCollectionManagerTestPlugins, aclTestPlugins, prepareApp } from './prepare';

describe('acl', () => {
  let app: MockServer;
  let db: Database;
  let acl: ACL;
  let admin;
  let adminAgent;

  afterAll(async () => {
    await app.destroy();
  });

  beforeAll(async () => {
    app = await prepareApp({
      plugins: aclCollectionManagerTestPlugins,
    });
    db = app.db;
    acl = app.acl;

    const UserRepo = db.getCollection('users').repository;

    admin = await UserRepo.create({
      values: {
        roles: ['admin'],
      },
    });

    adminAgent = app.agent().login(admin);
  });

  test('append createById', async () => {
    const roleName = 'acl-create-by-id-role';
    await db.getRepository('collections').create({
      context: {},
      values: {
        name: 'companies',
        fields: [
          {
            type: 'string',
            name: 'name',
          },
          {
            type: 'hasMany',
            name: 'users',
          },
        ],
      },
    });

    await db.getRepository('collections').create({
      context: {},
      values: {
        name: 'repairs',
        createdBy: true,
        fields: [
          {
            type: 'belongsTo',
            name: 'company',
          },
          {
            type: 'string',
            name: 'name',
          },
        ],
      },
    });

    const c1 = await db.getRepository('companies').create({
      values: {
        name: 'c1',
      },
    });

    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    const createResp = await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: 'repairs',
        usingActionsConfig: true,
        actions: [
          {
            name: 'list',
            fields: ['id'],
          },
        ],
      },
    });

    expect(createResp.statusCode).toEqual(200);

    const u1 = await db.getRepository('users').create({
      values: {
        name: 'u1',
        company: { id: c1.get('id') },
        roles: [roleName],
      },
    });

    await db.getRepository('repairs').create({
      values: {
        name: 'r1',
        company: { id: c1.get('id') },
      },
    });

    const testAgent = app.agent().login(u1);

    // Repeated requests guard against ACL params accumulating duplicate fields across requests.
    // @ts-ignore
    await testAgent.resource('repairs').list({
      filter: {
        company: {
          id: {
            $isVar: 'currentUser.company.id',
          },
        },
      },
    });

    // @ts-ignore
    await testAgent.resource('repairs').list({
      filter: {
        company: {
          id: {
            $isVar: 'currentUser.company.id',
          },
        },
      },
    });

    // @ts-ignore
    await testAgent.resource('repairs').list({
      filter: {
        company: {
          id: {
            $isVar: 'currentUser.company.id',
          },
        },
      },
    });

    const acl = app.acl;
    const canResult = acl.can({ role: roleName, resource: 'repairs', action: 'list' });
    const params = canResult['params'];

    expect(params['fields']).toHaveLength(3);
  });

  it('should not have permission to list comments', async () => {
    const roleName = 'acl-comments-role';
    const commentsCollection = 'aclComments';
    const postsCollection = 'aclCommentPosts';
    await db.getCollection('collections').repository.create({
      values: {
        name: commentsCollection,
        fields: [
          {
            name: 'content',
            type: 'string',
          },
        ],
      },
      context: {},
    });

    await db.getCollection('collections').repository.create({
      values: {
        name: postsCollection,
        fields: [
          {
            name: 'title',
            type: 'string',
          },
          {
            name: 'comments',
            type: 'hasMany',
            target: commentsCollection,
            interface: 'linkTo',
          },
        ],
      },
      context: {},
    });

    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: postsCollection,
        usingActionsConfig: true,
        actions: [
          {
            name: 'view',
            fields: ['comments'],
          },
        ],
      },
    });

    const acl = app.acl;

    expect(
      acl.can({
        role: roleName,
        resource: `${postsCollection}.comments`,
        action: 'list',
      }),
    ).not.toBeNull();

    expect(
      acl.can({
        role: roleName,
        resource: commentsCollection,
        action: 'list',
      }),
    ).toBeNull();
  });

  it('should not destroy default roles when user is root user', async () => {
    const rootUser = await db.getRepository('users').findOne({
      filter: {
        specialRole: 'root',
      },
    });

    const adminAgent = app.agent().login(rootUser);

    const defaultRoleNames = ['root', 'admin', 'member'];
    expect(
      await db.getCollection('roles').repository.count({
        filter: {
          name: {
            $in: defaultRoleNames,
          },
        },
      }),
    ).toBe(defaultRoleNames.length);

    //@ts-ignore
    await adminAgent.resource('roles').destroy({
      filterByTk: 'root',
    });

    expect(
      await db.getCollection('roles').repository.count({
        filter: {
          name: {
            $in: defaultRoleNames,
          },
        },
      }),
    ).toBe(defaultRoleNames.length);
  });

  it('should not destroy default roles', async () => {
    const defaultRoleNames = ['root', 'admin', 'member'];
    expect(
      await db.getCollection('roles').repository.count({
        filter: {
          name: {
            $in: defaultRoleNames,
          },
        },
      }),
    ).toBe(defaultRoleNames.length);

    await adminAgent.resource('roles').destroy({
      filterByTk: 'root',
    });

    expect(
      await db.getCollection('roles').repository.count({
        filter: {
          name: {
            $in: defaultRoleNames,
          },
        },
      }),
    ).toBe(defaultRoleNames.length);
  });

  it('should not destroy all scope', async () => {
    let allScope = await adminAgent.resource('rolesResourcesScopes').get({
      filter: {
        key: 'all',
      },
    });

    expect(allScope.body.data).toBeDefined();

    await adminAgent.resource('rolesResourcesScopes').destroy({
      filter: {
        key: 'all',
      },
    });

    allScope = await adminAgent.resource('rolesResourcesScopes').get({
      filter: {
        key: 'all',
      },
    });

    expect(allScope.body.data).toBeDefined();
  });

  it('should not destroy roles collections', async () => {
    let rolesCollection = await adminAgent.resource('collections').get({
      filterByTk: 'roles',
    });

    expect(rolesCollection.body.data).toBeDefined();

    await adminAgent.resource('collections').destroy({
      filterByTk: 'roles',
    });

    rolesCollection = await adminAgent.resource('collections').get({
      filterByTk: 'roles',
    });

    expect(rolesCollection.body.data).toBeDefined();
  });

  it('should works with universal actions', async () => {
    const roleName = 'acl-universal-actions-role';
    const resourceName = 'aclUniversalPosts';
    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: resourceName,
        action: 'create',
      }),
    ).toBeNull();

    // grant universal action
    await adminAgent.resource('roles').update({
      resourceIndex: roleName,
      values: {
        strategy: {
          actions: ['create'],
        },
      },
      forceUpdate: true,
    });

    expect(
      acl.can({
        role: roleName,
        resource: resourceName,
        action: 'create',
      }),
    ).toMatchObject({
      role: roleName,
      resource: resourceName,
      action: 'create',
    });
  });

  it('should deny when resource action has no resource', async () => {
    const roleName = 'acl-empty-resource-actions-role';
    const c1Collection = 'aclEmptyResourceC1';
    const c2Collection = 'aclEmptyResourceC2';
    await db.getRepository('roles').create({
      values: {
        name: roleName,
        strategy: {
          actions: ['update:own', 'destroy:own', 'create', 'view'],
        },
      },
    });

    // create c1 collection
    await db.getRepository('collections').create({
      values: {
        name: c1Collection,
        title: 'table1',
      },
    });

    // create c2 collection
    await db.getRepository('collections').create({
      values: {
        name: c2Collection,
        title: 'table2',
      },
    });

    await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: c1Collection,
        usingActionsConfig: true,
        actions: [],
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: c1Collection,
        action: 'list',
      }),
    ).toBeNull();
  });

  it('should not append createdAt field when collection has no createdAt field', async () => {
    const roleName = 'acl-no-created-at-role';
    const collectionName = 'aclNoCreatedAt';
    await db.getRepository('roles').create({
      values: {
        name: roleName,
        strategy: {
          actions: ['list'],
        },
      },
    });

    await db.getRepository('collections').create({
      values: {
        name: collectionName,
        autoGenId: false,
        fields: [
          { name: 'name', type: 'string', primaryKey: true },
          { name: 'title', type: 'string' },
        ],
        timestamps: false,
      },
      context: {},
    });

    await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          {
            name: 'view',
            fields: ['title'],
          },
        ],
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: collectionName,
        action: 'view',
      }),
    ).toMatchObject({
      role: roleName,
      resource: collectionName,
      action: 'view',
      params: {
        fields: ['title', 'name'],
      },
    });
  });

  it('should works with resources actions', async () => {
    const roleName = 'acl-resource-actions-role';
    const c1Collection = 'aclResourceActionsC1';
    const c2Collection = 'aclResourceActionsC2';
    await db.getRepository('roles').create({
      values: {
        name: roleName,
        strategy: {
          actions: ['list'],
        },
      },
    });

    // create c1 collection
    await db.getRepository('collections').create({
      values: {
        name: c1Collection,
        title: 'table1',
      },
      context: {},
    });

    // create c2 collection
    await db.getRepository('collections').create({
      values: {
        name: c2Collection,
        title: 'table2',
      },
    });

    // create c1 published scope
    const {
      body: { data: publishedScope },
    } = await adminAgent.resource('dataSourcesRolesResourcesScopes').create({
      values: {
        resourceName: c1Collection,
        name: 'published',
        scope: {
          published: true,
        },
      },
    });

    // set admin resources
    await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: c1Collection,
        usingActionsConfig: true,
        actions: [
          {
            name: 'create',
            scope: publishedScope.id,
          },
          {
            name: 'view',
            fields: ['title', 'age'],
          },
        ],
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: c1Collection,
        action: 'create',
      }),
    ).toMatchObject({
      role: roleName,
      resource: c1Collection,
      action: 'create',
      params: {
        filter: { published: true },
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: c1Collection,
        action: 'view',
      }),
    ).toMatchObject({
      role: roleName,
      resource: c1Collection,
      action: 'view',
      params: {
        fields: ['age', 'title', 'id', 'createdAt', 'updatedAt'],
      },
    });

    // revoke action
    const response = await adminAgent.resource('roles.resources', roleName).list({
      appends: ['actions'],
    });

    expect(response.statusCode).toEqual(200);

    const collectionName = response.body.data[0].name;

    await adminAgent.resource('roles.resources', roleName).update({
      filter: {
        name: collectionName,
        dataSourceKey: 'main',
      },
      values: {
        name: c1Collection,
        usingActionsConfig: true,
        actions: [
          {
            name: 'view',
            fields: ['title', 'age'],
          },
        ],
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: c1Collection,
        action: 'create',
      }),
    ).toBeNull();
  });

  it('should revoke resource when collection destroy', async () => {
    const roleName = 'acl-revoke-resource-role';
    const collectionName = 'aclRevokePosts';
    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    await db.getRepository('collections').create({
      values: {
        name: collectionName,
      },
    });

    await db.getRepository('fields').create({
      values: {
        collectionName,
        type: 'string',
        name: 'title',
      },
    });

    await adminAgent.resource('roles.resources').create({
      associatedIndex: roleName,
      values: {
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          {
            name: 'view',
            fields: ['title'],
          },
        ],
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: collectionName,
        action: 'view',
      }),
    ).not.toBeNull();

    await db.getRepository('collections').destroy({
      filter: {
        name: collectionName,
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: collectionName,
        action: 'view',
      }),
    ).toBeNull();
  });

  it('should revoke actions when not using actions config', async () => {
    const roleName = 'acl-revoke-actions-role';
    const collectionName = 'aclRevokeActionPosts';
    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    await db.getRepository('collections').create({
      values: {
        name: collectionName,
        title: collectionName,
      },
    });

    await adminAgent.resource('roles.resources').create({
      associatedIndex: roleName,
      values: {
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          {
            name: 'create',
          },
        ],
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: collectionName,
        action: 'create',
      }),
    ).toMatchObject({
      role: roleName,
      resource: collectionName,
      action: 'create',
    });

    const existsResource = await db.getRepository('dataSourcesRolesResources').findOne({
      filter: {
        name: collectionName,
        roleName,
        dataSourceKey: 'main',
      },
    });

    await adminAgent.resource('roles.resources', roleName).update({
      filterByTk: existsResource.get('id'),
      values: {
        usingActionsConfig: false,
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: collectionName,
        action: 'create',
      }),
    ).toBeNull();

    await adminAgent.resource('roles.resources', roleName).update({
      filterByTk: existsResource.get('id'),
      values: {
        usingActionsConfig: true,
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: collectionName,
        action: 'create',
      }),
    ).toMatchObject({
      role: roleName,
      resource: collectionName,
      action: 'create',
    });
  });

  it('should add fields when field created', async () => {
    const roleName = 'acl-add-fields-role';
    const collectionName = 'aclAddFieldsPosts';
    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    await db.getRepository('collections').create({
      values: {
        name: collectionName,
      },
    });

    await db.getRepository('fields').create({
      values: {
        collectionName,
        type: 'string',
        name: 'title',
      },
    });

    await adminAgent.resource('roles.resources').create({
      associatedIndex: roleName,
      values: {
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          {
            name: 'view',
            fields: ['title'],
          },
        ],
      },
    });

    const allowFields = acl.can({
      role: roleName,
      resource: collectionName,
      action: 'view',
    })['params']['fields'];

    expect(allowFields.includes('title')).toBeTruthy();

    await db.getRepository('fields').create({
      values: {
        collectionName,
        type: 'string',
        name: 'description',
      },
    });

    const newAllowFields = acl.can({
      role: roleName,
      resource: collectionName,
      action: 'view',
    })['params']['fields'];

    expect(newAllowFields.includes('description')).toBeTruthy();
  });

  it.skip('should sync data to acl after app reload', async () => {
    const role = await db.getRepository('roles').create({
      values: {
        name: 'new',
        resources: [
          {
            name: 'posts',
            usingActionsConfig: true,
            actions: [
              {
                name: 'view',
                fields: ['title'],
              },
            ],
          },
        ],
      },
      hooks: false,
    });

    expect(app.acl.getRole('new')).toBeUndefined();

    await app.reload();

    expect(app.acl.getRole('new')).toBeDefined();

    expect(
      app.acl.can({
        role: 'new',
        resource: 'posts',
        action: 'view',
      }),
    ).toMatchObject({
      role: 'new',
      resource: 'posts',
      action: 'view',
    });
  });

  it('should destroy new role when user are root user', async () => {
    const roleName = 'acl-root-destroy-role';
    const rootUser = await db.getRepository('users').findOne({
      filterByTk: 1,
    });

    const rootAgent = app.agent().login(rootUser);

    const response = await rootAgent
      // @ts-ignore
      .resource('roles')
      .create({
        values: {
          name: roleName,
        },
      });

    expect(response.statusCode).toEqual(200);

    expect(await db.getRepository('roles').findOne({ filterByTk: roleName })).toBeDefined();
    const destroyResponse = await rootAgent
      // @ts-ignore
      .resource('roles')
      .destroy({
        filterByTk: roleName,
      });

    expect(destroyResponse.statusCode).toEqual(200);
    expect(await db.getRepository('roles').findOne({ filterByTk: roleName })).toBeNull();
  });
});

describe('acl role menus', () => {
  let app: MockServer;
  let db: Database;
  let adminAgent;

  beforeAll(async () => {
    // aclTestPlugins includes ui-schema-storage for menu ACL tests; aclCollectionManagerTestPlugins is used by collection ACL coverage.
    app = await prepareApp({
      plugins: aclTestPlugins,
    });
    db = app.db;

    const admin = await db.getCollection('users').repository.create({
      values: {
        roles: ['admin'],
      },
    });

    adminAgent = app.agent().login(admin);
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should get role menus', async () => {
    const roleName = 'acl-menu-list-role';
    await db.getRepository('roles').create({
      values: {
        name: roleName,
        strategy: {
          actions: ['view'],
        },
      },
    });

    const menuResponse = await adminAgent.resource('roles.menuUiSchemas', roleName).list();

    expect(menuResponse.statusCode).toEqual(200);
  });

  it('should toggle role menus', async () => {
    const roleName = 'acl-menu-toggle-role';
    const schemaUid = `acl-menu-toggle-${uid()}`;
    await db.getRepository('roles').create({
      values: {
        name: roleName,
        strategy: {
          actions: ['*'],
        },
        snippets: ['pm.*'],
      },
    });
    const user = await db.getCollection('users').repository.create({
      values: {
        roles: [roleName],
      },
    });

    const userAgent = app.agent().login(user);

    await db.getRepository('uiSchemas').insert({
      'x-uid': schemaUid,
    });

    const response = await userAgent
      // @ts-ignore
      .resource('roles.menuUiSchemas', roleName)
      .toggle({
        values: { tk: schemaUid },
      });

    expect(response.statusCode).toEqual(200);
  });
});
