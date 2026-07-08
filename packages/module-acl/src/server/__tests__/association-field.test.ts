import { MockServer } from '@tachybase/test';
import { ACL, Database, HasManyRepository, uid } from '@tego/server';

import { aclCollectionManagerTestPlugins, prepareApp, registerHasManyAssociationActions } from './prepare';

async function prepareAssociationFieldAclApp() {
  const app = await prepareApp({
    plugins: aclCollectionManagerTestPlugins,
  });
  const db = app.db;
  const acl = app.acl;

  await db.getRepository('roles').create({
    values: {
      name: 'testAdmin',
      snippets: ['pm.*'],
    },
  });

  const UserRepo = db.getCollection('users').repository;

  const admin = await UserRepo.create({
    values: {
      roles: ['testAdmin'],
    },
  });

  const adminAgent = app.agent().login(admin);

  await db.getRepository('collections').create({
    values: {
      name: 'orders',
    },
    context: {},
  });

  await db.getRepository('collections.fields', 'users').create({
    values: {
      name: 'name',
      type: 'string',
    },
    context: {},
  });

  await db.getRepository('collections.fields', 'users').create({
    values: {
      name: 'age',
      type: 'integer',
    },
    context: {},
  });

  await db.getRepository('collections.fields', 'users').create({
    values: {
      interface: 'linkTo',
      name: 'orders',
      type: 'hasMany',
      target: 'orders',
    },
    context: {},
  });

  await db.getRepository('collections.fields', 'orders').create({
    values: {
      name: 'content',
      type: 'string',
    },
    context: {},
  });

  async function createRoleWithAssociationAccess(roleName: string) {
    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    const user = await UserRepo.create({
      values: {
        roles: [roleName],
      },
    });

    const userAgent = app.agent().login(user);

    await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: 'users',
        usingActionsConfig: true,
        actions: [
          {
            name: 'create',
            fields: ['orders'],
          },
          {
            name: 'view',
            fields: ['orders'],
          },
        ],
      },
    });

    await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: 'orders',
        usingActionsConfig: true,
        actions: [
          {
            name: 'view',
          },
        ],
      },
    });

    return { user, userAgent };
  }

  return { app, db, acl, adminAgent, createRoleWithAssociationAccess };
}

describe('association test', () => {
  let app: MockServer;
  let db: Database;
  let acl: ACL;

  let user;
  let userAgent;
  let admin;
  let adminAgent;

  afterEach(async () => {
    await app.destroy();
  });

  beforeEach(async () => {
    app = await prepareApp({
      plugins: aclCollectionManagerTestPlugins,
    });
    db = app.db;
    acl = app.acl;
  });

  it('should set association actions', async () => {
    registerHasManyAssociationActions(app);

    await db.getRepository('collections').create({
      values: {
        name: 'posts',
        fields: [
          { name: 'title', type: 'string' },
          { name: 'userComments', type: 'hasMany', target: 'comments', interface: 'linkTo' },
        ],
      },
      context: {},
    });

    await db.getRepository('collections').create({
      values: {
        name: 'comments',
        fields: [{ name: 'content', type: 'string' }],
      },
      context: {},
    });

    await db.getRepository('roles').create({
      values: {
        name: 'test-role',
      },
      context: {},
    });

    await db.getRepository('roles.resources', 'test-role').create({
      values: {
        name: 'posts',
        usingActionsConfig: true,
        actions: [
          {
            name: 'view',
            fields: ['userComments'],
          },
        ],
      },
      context: {},
    });

    const role = acl.getRole('test-role');

    expect(
      acl.can({
        role: 'test-role',
        action: 'list',
        resource: 'posts.userComments',
      }),
    ).not.toBeNull();

    const post = await db.getRepository('posts').create({
      values: {
        title: 'hello world',
        userComments: [{ content: 'comment 1' }],
      },
    });

    const UserRepo = db.getCollection('users').repository;
    const user = await UserRepo.create({
      values: {
        roles: ['test-role'],
      },
    });

    const userAgent = app.agent().login(user);

    //@ts-ignore
    const response = await userAgent.resource('posts').list({});
    expect(response.statusCode).toEqual(200);
    const post1 = response.body.data[0];
    expect(post1.userComments).not.toBeDefined();
  });
});

describe('association field acl defaults', () => {
  let app: MockServer;
  let acl: ACL;
  let createRoleWithAssociationAccess: (roleName: string) => Promise<{ user: any; userAgent: any }>;

  afterEach(async () => {
    await app.destroy();
  });

  beforeEach(async () => {
    const prepared = await prepareAssociationFieldAclApp();
    app = prepared.app;
    acl = prepared.acl;
    createRoleWithAssociationAccess = prepared.createRoleWithAssociationAccess;
  });

  it('should not grant association actions without explicit association field action registration', async () => {
    const roleName = `default-association-role-${uid()}`;
    await createRoleWithAssociationAccess(roleName);

    expect(
      acl.can({
        role: roleName,
        resource: 'users.orders',
        action: 'add',
      }),
    ).toBeNull();

    expect(
      acl.can({
        role: roleName,
        resource: 'users.orders',
        action: 'list',
      }),
    ).toBeNull();
  });
});

describe('association field acl', () => {
  let app: MockServer;
  let db: Database;
  let acl: ACL;

  let userAgent;
  let adminAgent;
  let createRoleWithAssociationAccess: (roleName: string) => Promise<{ user: any; userAgent: any }>;

  afterAll(async () => {
    await app.destroy();
  });

  beforeAll(async () => {
    const prepared = await prepareAssociationFieldAclApp();
    app = prepared.app;
    db = prepared.db;
    acl = prepared.acl;
    adminAgent = prepared.adminAgent;
    createRoleWithAssociationAccess = prepared.createRoleWithAssociationAccess;
  });

  // skip because of disable grant associations target action
  it.skip('should revoke target action on association action revoke', async () => {
    expect(
      acl.can({
        role: 'new',
        resource: 'orders',
        action: 'list',
      }),
    ).toMatchObject({
      role: 'new',
      resource: 'orders',
      action: 'list',
    });

    await adminAgent.resource('roles.resources', 'new').update({
      values: {
        name: 'users',
        usingActionsConfig: true,
        actions: [],
      },
    });

    expect(
      acl.can({
        role: 'new',
        resource: 'orders',
        action: 'list',
      }),
    ).toBeNull();
  });

  it('should revoke association action on action revoke', async () => {
    registerHasManyAssociationActions(app);

    const roleName = `revoke-action-role-${uid()}`;
    await createRoleWithAssociationAccess(roleName);

    expect(
      acl.can({
        role: roleName,
        resource: 'users.orders',
        action: 'add',
      }),
    ).toMatchObject({
      role: roleName,
      resource: 'users.orders',
      action: 'add',
    });

    const roleResource = await db.getRepository('dataSourcesRolesResources').findOne({
      filter: {
        name: 'users',
        roleName,
      },
    });

    const viewAction = await db
      .getRepository<HasManyRepository>('dataSourcesRolesResources.actions', roleResource.get('id') as string)
      .findOne({
        filter: {
          name: 'view',
        },
      });

    const actionId = viewAction.get('id') as number;

    const response = await adminAgent.resource('roles.resources', roleName).update({
      filter: {
        name: 'users',
        dataSourceKey: 'main',
      },
      values: {
        name: 'users',
        usingActionsConfig: true,
        actions: [
          {
            id: actionId,
          },
        ],
      },
    });

    expect(response.statusCode).toEqual(200);

    expect(
      acl.can({
        role: roleName,
        resource: 'users.orders',
        action: 'add',
      }),
    ).toBeNull();
  });

  it('should not redundant fields after field set', async () => {
    const roleName = `field-set-role-${uid()}`;
    const collectionName = `fieldSetPosts_${uid()}`;
    await createRoleWithAssociationAccess(roleName);

    await db.getRepository('collections').create({
      values: {
        name: collectionName,
      },
      context: {},
    });

    await db.getRepository('collections.fields', collectionName).create({
      values: {
        name: 'title',
        type: 'string',
      },
      context: {},
    });

    await db.getRepository('collections.fields', collectionName).create({
      values: {
        name: 'content',
        type: 'string',
      },
      context: {},
    });

    await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          {
            name: 'create',
            fields: ['content', 'title'],
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
      params: {
        whitelist: ['content', 'title'],
      },
    });

    await adminAgent.resource('collections').setFields({
      filterByTk: collectionName,
      values: {
        fields: [
          {
            name: 'name',
            type: 'string',
          },
          {
            name: 'content',
            type: 'text',
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
      params: {
        whitelist: ['content', 'name'],
      },
    });
  });

  it('should allow association fields access', async () => {
    registerHasManyAssociationActions(app);

    const roleName = `allow-association-role-${uid()}`;
    ({ userAgent } = await createRoleWithAssociationAccess(roleName));

    const createResponse = await userAgent.resource('users').create({
      values: {
        orders: [
          {
            content: 'apple',
          },
        ],
      },
    });

    expect(createResponse.statusCode).toEqual(200);

    const user = await db.getRepository('users').findOne({
      filterByTk: createResponse.body.data.id,
    });
    // @ts-ignore
    expect(await user.countOrders()).toEqual(1);

    expect(
      acl.can({
        role: roleName,
        resource: 'users.orders',
        action: 'list',
      }),
    ).toMatchObject({
      role: roleName,
      resource: 'users.orders',
      action: 'list',
    });

    expect(
      acl.can({
        role: roleName,
        resource: 'orders',
        action: 'list',
      }),
    ).toMatchObject({
      role: roleName,
      resource: 'orders',
      action: 'list',
    });
  });
});

describe('association field acl destructive schema changes', () => {
  let app: MockServer;
  let db: Database;
  let acl: ACL;
  let adminAgent;
  let createRoleWithAssociationAccess: (roleName: string) => Promise<{ user: any; userAgent: any }>;

  afterEach(async () => {
    await app.destroy();
  });

  beforeEach(async () => {
    const prepared = await prepareAssociationFieldAclApp();
    app = prepared.app;
    db = prepared.db;
    acl = prepared.acl;
    adminAgent = prepared.adminAgent;
    createRoleWithAssociationAccess = prepared.createRoleWithAssociationAccess;
  });

  it('should revoke association action on field deleted', async () => {
    const roleName = 'field-delete-role';
    await createRoleWithAssociationAccess(roleName);

    await adminAgent.resource('roles.resources', roleName).update({
      filter: {
        name: 'users',
        dataSourceKey: 'main',
      },
      values: {
        name: 'users',
        usingActionsConfig: true,
        actions: [
          {
            name: 'create',
            fields: ['name', 'age'],
          },
        ],
      },
    });

    expect(
      acl.can({
        role: roleName,
        resource: 'users',
        action: 'create',
      }),
    ).toMatchObject({
      role: roleName,
      resource: 'users',
      action: 'create',
      params: {
        whitelist: ['age', 'name'],
      },
    });

    const roleResource = await db.getRepository('dataSourcesRolesResources').findOne({
      filter: {
        name: 'users',
        roleName,
      },
    });

    const action = await db
      .getRepository<HasManyRepository>('dataSourcesRolesResources.actions', roleResource.get('id') as string)
      .findOne({
        filter: {
          name: 'create',
        },
      });

    expect(action.get('fields').includes('name')).toBeTruthy();

    // remove field
    await db.getRepository<HasManyRepository>('collections.fields', 'users').destroy({
      filter: {
        name: 'name',
      },
      context: {},
    });

    expect(
      acl.can({
        role: roleName,
        resource: 'users',
        action: 'create',
      }),
    ).toMatchObject({
      role: roleName,
      resource: 'users',
      action: 'create',
      params: {
        whitelist: ['age'],
      },
    });
  });
});
