import { MockServer } from '@tachybase/test';
import { Database } from '@tego/server';

import { aclLightTestPlugins, prepareApp } from './prepare';

describe('middleware', () => {
  let app: MockServer;
  let db: Database;
  let adminAgent;

  beforeAll(async () => {
    app = await prepareApp({
      plugins: aclLightTestPlugins,
    });
    db = app.db;

    const UserRepo = db.getCollection('users').repository;
    const admin = await UserRepo.create({
      values: {
        roles: ['admin'],
      },
    });

    adminAgent = app.agent().login(admin);
  });

  afterAll(async () => {
    await app.destroy();
  });

  const createPostCollection = async (name: string) => {
    db.collection({
      name,
      fields: [
        {
          name: 'title',
          type: 'string',
        },
        {
          name: 'description',
          type: 'string',
        },
        {
          name: 'createdById',
          type: 'integer',
        },
      ],
    });

    await db.sync();
  };

  const createRoleAgent = async (roleName: string, strategy?: any) => {
    await db.getRepository('roles').create({
      values: {
        name: roleName,
        strategy,
      },
    });

    const user = await db.getCollection('users').repository.create({
      values: {
        roles: [roleName],
      },
    });

    return {
      user,
      agent: app.agent().login(user).set('X-Role', roleName),
    };
  };

  it('should throw 401 when no authentication', async () => {
    const collectionName = 'middlewareAuthPosts';
    await createPostCollection(collectionName);

    const response = await app.agent().resource(collectionName).create({
      values: {},
    });

    expect(response.statusCode).toEqual(401);
  });

  it('should return 200 when role has permission', async () => {
    const collectionName = 'middlewareAllowedPosts';
    const roleName = 'middlewareCreateRole';
    await createPostCollection(collectionName);
    const { agent } = await createRoleAgent(roleName, {
      actions: ['create:all'],
    });

    const response = await agent.resource(collectionName).create({
      values: {},
    });

    expect(response.statusCode).toEqual(200);
  });

  it('should limit fields on view actions', async () => {
    const collectionName = 'middlewareViewFieldsPosts';
    const roleName = 'middlewareViewFieldsRole';
    await createPostCollection(collectionName);
    const { agent } = await createRoleAgent(roleName);

    await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          {
            name: 'create',
            fields: ['title', 'description'],
          },
          {
            name: 'view',
            fields: ['title'],
          },
        ],
      },
    });

    await agent.resource(collectionName).create({
      values: {
        title: 'post-title',
        description: 'post-description',
      },
    });

    const post = await db.getRepository(collectionName).findOne();
    expect(post.get('title')).toEqual('post-title');
    expect(post.get('description')).toEqual('post-description');

    const response = await agent.resource(collectionName).list({});
    expect(response.statusCode).toEqual(200);

    const [data] = response.body.data;

    expect(data['id']).not.toBeUndefined();
    expect(data['title']).toEqual('post-title');
    expect(data['description']).toBeUndefined();
  });

  it('should parse template value on action params', async () => {
    const collectionName = 'middlewareTemplateScopePosts';
    const roleName = 'middlewareTemplateScopeRole';
    await createPostCollection(collectionName);
    const { user, agent } = await createRoleAgent(roleName);

    const res = await adminAgent.resource('dataSourcesRolesResourcesScopes').create({
      values: {
        name: 'middlewareTemplateScopeOwn',
        scope: {
          createdById: '{{ ctx.state.currentUser.id }}',
        },
      },
    });

    await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          {
            name: 'create',
            fields: ['title', 'description', 'createdById'],
          },
          {
            name: 'view',
            fields: ['title'],
            scope: res.body.data.id,
          },
        ],
      },
    });

    await agent.resource(collectionName).create({
      values: {
        title: 't1',
        description: 'd1',
        createdById: user.get('id'),
      },
    });

    await agent.resource(collectionName).create({
      values: {
        title: 't2',
        description: 'p2',
        createdById: Number(user.get('id')) + 1000,
      },
    });

    const response = await agent.resource(collectionName).list();
    const data = response.body.data;
    expect(data.length).toEqual(1);
  });

  it('should change fields params to whitelist in create action', async () => {
    const collectionName = 'middlewareCreateFieldsPosts';
    const roleName = 'middlewareCreateFieldsRole';
    await createPostCollection(collectionName);
    const { agent } = await createRoleAgent(roleName);

    await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          {
            name: 'create',
            fields: ['title'],
          },
        ],
      },
    });

    await agent.resource(collectionName).create({
      values: {
        title: 'post-title',
        description: 'post-description',
      },
    });

    const post = await db.getRepository(collectionName).findOne();
    expect(post.get('title')).toEqual('post-title');
    expect(post.get('description')).toBeNull();
  });
});
