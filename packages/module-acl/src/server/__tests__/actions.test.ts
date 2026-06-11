import { MockServer } from '@tachybase/test';

import { aclLightTestPlugins, prepareApp } from './prepare';

describe('destroy action with acl', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await prepareApp({
      plugins: aclLightTestPlugins,
    });
  });

  afterAll(async () => {
    await app.destroy();
  });

  const createPostCollection = async (name: string) => {
    const Post = app.db.collection({
      name,
      fields: [
        { type: 'string', name: 'title' },
        {
          type: 'bigInt',
          name: 'createdById',
        },
      ],
    });

    await app.db.sync();
    return Post;
  };

  const createUserAgent = async (roleName = 'user') => {
    await app.db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    const user = await app.db.getRepository('users').create({
      values: {
        roles: [roleName],
      },
    });

    return {
      agent: app.agent().login(user).set('X-Role', roleName),
      user,
    };
  };

  it('should create role through user resource', async () => {
    const UserCollection = app.db.getCollection('users');

    const user = await UserCollection.repository.create({
      values: {
        name: 'test_user',
      },
    });

    const userRolesRepository = app.db.getRepository('users.roles', user.get('id'));
    const roleName = 'r_voluptas-assumenda-omnis';
    await userRolesRepository.create({
      values: {
        name: roleName,
        snippets: ['!ui.*', '!pm', '!pm.*'],
        title: 'r_harum-qui-doloremque',
        resources: [
          {
            usingActionsConfig: true,
            actions: [
              {
                name: 'create',
                fields: ['id', 'nickname', 'username', 'email', 'phone', 'password', 'roles'],
                scope: null,
              },
              {
                name: 'view',
                fields: ['id', 'nickname', 'username', 'email', 'phone', 'password', 'roles'],
                scope: {
                  name: '数据范围',
                  scope: {
                    createdById: '{{ ctx.state.currentUser.id }}',
                  },
                },
              },
            ],
            name: 'users',
          },
        ],
      },
    });

    const role = await app.db.getRepository('roles').findOne({
      filter: {
        name: roleName,
      },
      appends: ['resources'],
    });

    expect(role.get('resources').length).toBe(1);
  });

  it('should load the association collection when the source collection does not have the createdById field', async () => {
    const roleName = 'acl-action-association-role';
    const aCollection = 'aclActionA';
    const bCollection = 'aclActionB';
    const A = app.db.collection({
      name: aCollection,
      fields: [
        { type: 'string', name: 'title' },
        { type: 'belongsToMany', name: 'bs', target: bCollection },
      ],
    });

    app.db.collection({
      name: bCollection,
      fields: [{ type: 'string', name: 'title' }],
    });

    await app.db.sync();

    await A.repository.create({
      values: [
        {
          title: 'a1',
          bs: [
            {
              title: 'b1',
            },
          ],
        },
      ],
    });

    const { agent: userAgent } = await createUserAgent(roleName);

    app.acl.define({
      role: roleName,
      strategy: {
        actions: ['view:own'],
      },
    });

    const a1 = await A.repository.findOne({ filter: { title: 'a1' } });

    const response = await userAgent.resource(`${aCollection}.bs`, a1.get('id')).list();
    expect(response.statusCode).toEqual(200);
  });

  it('should parse association acl params', async () => {
    const roleName = 'acl-action-parse-association-role';
    const postCollection = 'aclActionPosts';
    const commentCollection = 'aclActionComments';
    const Post = await createPostCollection(postCollection);
    app.db.collection({
      name: commentCollection,
      fields: [
        { type: 'string', name: 'content' },
        { type: 'belongsToMany', name: 'posts', target: postCollection },
      ],
    });

    await app.db.sync();

    await Post.repository.create({
      values: [
        {
          title: 'p1',
          comments: [
            {
              content: 'c11',
            },
            {
              content: 'c12',
            },
          ],
        },
        {
          title: 'p2',
          comments: [
            {
              content: 'c21',
            },
            {
              content: 'c22',
            },
          ],
        },
      ],
    });

    const { agent: userAgent } = await createUserAgent(roleName);

    app.acl.define({
      role: roleName,
      strategy: {
        actions: ['view:own'],
      },
    });

    const p1 = await Post.repository.findOne({ filter: { title: 'p1' } });

    const response = await userAgent.resource(`${postCollection}.comments`, p1.get('id')).list();
    expect(response.statusCode).toEqual(403);
  });

  it('should be a no-op when user has no permission to destroy record', async () => {
    const roleName = 'acl-action-destroy-own-role';
    const postCollection = 'aclActionDestroyPosts';
    const Post = await createPostCollection(postCollection);
    const { agent: userAgent, user } = await createUserAgent(roleName);

    const userRole = app.acl.define({
      role: roleName,
    });

    // user can destroy post which created by himself
    userRole.grantAction(`${postCollection}:destroy`, {
      own: true,
    });

    const p1 = await Post.repository.create({
      values: {
        title: 'p1',
        createdById: user.get('id') + 1,
      },
    });

    const response = await userAgent.resource(postCollection).destroy({
      filterByTk: p1.get('id'),
    });

    expect(response.statusCode).toEqual(200);
    await expect(Post.repository.findOne({ filterByTk: p1.get('id') })).resolves.toBeTruthy();
  });

  it('should only destroy records matching array query permission', async () => {
    const roleName = 'acl-action-array-query-role';
    const postCollection = 'aclActionArrayPosts';
    const Post = await createPostCollection(postCollection);
    const { agent: userAgent } = await createUserAgent(roleName);

    const userRole = app.acl.define({
      role: roleName,
    });

    userRole.grantAction(`${postCollection}:destroy`, {
      filter: {
        'title.$in': ['p1', 'p2', 'p3'],
      },
    });

    await Post.repository.create({
      values: [
        {
          title: 'p1',
        },
        {
          title: 'p2',
        },
        {
          title: 'p3',
        },
        {
          title: 'p4',
        },
        {
          title: 'p5',
        },
        {
          title: 'p6',
        },
      ],
    });

    const response = await userAgent.resource(postCollection).destroy({
      filter: {
        'title.$in': ['p4', 'p5', 'p6'],
      },
    });

    // Requests outside the configured destroy filter are accepted but do not remove records.
    expect(response.statusCode).toEqual(200);
    expect(await Post.repository.count({ filter: { 'title.$in': ['p4', 'p5', 'p6'] } })).toEqual(3);

    const response2 = await userAgent.resource(postCollection).destroy({
      filter: {
        'title.$in': ['p1'],
      },
    });

    expect(response2.statusCode).toEqual(200);
    expect(await Post.repository.count({ filter: { 'title.$in': ['p1'] } })).toEqual(0);
  });
});
