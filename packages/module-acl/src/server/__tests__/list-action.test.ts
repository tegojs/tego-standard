import { MockServer } from '@tachybase/test';
import { Database } from '@tego/server';

import { aclCollectionManagerTestPlugins, aclLightTestPlugins, prepareApp } from './prepare';

describe('list action with acl', () => {
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
      createdBy: true,
      fields: [
        { type: 'string', name: 'title' },
        {
          type: 'bigInt',
          name: 'createdById',
        },
        {
          type: 'belongsTo',
          name: 'createdBy',
          target: 'users',
        },
      ],
    });

    await app.db.sync();
    return Post;
  };

  const createUserAgent = async (roleName: string) => {
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

    const otherUser = await app.db.getRepository('users').create({
      values: {},
    });

    return {
      user,
      otherUser,
      userId: user.get('id'),
      otherUserId: otherUser.get('id'),
      agent: app.agent().login(user).set('X-Role', roleName).set('X-With-ACL-Meta', true),
    };
  };

  it('should list with meta permission that has difference primary key', async () => {
    const roleName = 'acl-list-string-pk-role';
    const collectionName = 'aclListStringPkTests';
    app.acl.addFixedParams(collectionName, 'destroy', () => {
      return {
        filter: {
          $and: [{ 'name.$ne': 't1' }, { 'name.$ne': 't2' }],
        },
      };
    });

    const Test = app.db.collection({
      name: collectionName,
      createdBy: true,
      fields: [
        { type: 'string', name: 'name', primaryKey: true },
        {
          type: 'bigInt',
          name: 'createdById',
        },
        {
          type: 'belongsTo',
          name: 'createdBy',
          target: 'users',
        },
      ],
      autoGenId: false,
      filterTargetKey: 'name',
    });

    await app.db.sync();

    const { agent, userId, otherUserId } = await createUserAgent(roleName);

    const userRole = app.acl.define({
      role: roleName,
    });

    userRole.grantAction(`${collectionName}:view`, {});

    userRole.grantAction(`${collectionName}:update`, {
      filter: {
        $and: [{ createdById: '{{ ctx.state.currentUser.id }}' }],
      },
    });

    userRole.grantAction(`${collectionName}:destroy`, {});

    await Test.model.bulkCreate([
      { name: 't1', createdById: userId },
      { name: 't2', createdById: userId },
      { name: 't3', createdById: otherUserId },
    ]);

    //@ts-ignore
    const response = await agent.resource(collectionName).list({});

    const data = response.body;
    expect(data.meta.allowedActions.view).toEqual(['t1', 't2', 't3']);
    expect(data.meta.allowedActions.update).toEqual(['t1', 't2']);
    expect(data.meta.allowedActions.destroy).toEqual(['t3']);
  });

  it('should list items meta permissions by association field', async () => {
    const roleName = 'acl-list-association-meta-role';
    const collectionName = 'aclListAssociationMetaPosts';
    const Post = await createPostCollection(collectionName);
    const { agent, userId, otherUserId } = await createUserAgent(roleName);

    const userRole = app.acl.define({
      role: roleName,
    });

    userRole.grantAction(`${collectionName}:view`, {});

    userRole.grantAction(`${collectionName}:update`, {
      filter: {
        $and: [{ createdById: '{{ ctx.state.currentUser.id }}' }],
      },
    });

    const posts = await Post.model.bulkCreate([
      { title: 'p1', createdById: userId },
      { title: 'p2', createdById: userId },
      { title: 'p3', createdById: otherUserId },
    ]);
    const allowedViewIds = posts.map((post) => post.get('id'));
    const allowedUpdateIds = posts.slice(0, 2).map((post) => post.get('id'));

    const response = await (agent as any).resource(collectionName).list();
    const data = response.body;
    expect(data.meta.allowedActions.view).toEqual(allowedViewIds);
    expect(data.meta.allowedActions.update).toEqual(allowedUpdateIds);
    expect(data.meta.allowedActions.destroy).toEqual([]);
  });

  it('should list items with meta permission', async () => {
    const roleName = 'acl-list-meta-role';
    const collectionName = 'aclListMetaPosts';
    const Post = await createPostCollection(collectionName);
    const { agent, userId, otherUserId } = await createUserAgent(roleName);

    const userRole = app.acl.define({
      role: roleName,
    });

    userRole.grantAction(`${collectionName}:view`, {});

    userRole.grantAction(`${collectionName}:update`, {
      filter: {
        $and: [{ createdById: '{{ ctx.state.currentUser.id }}' }],
      },
    });

    const posts = await Post.model.bulkCreate([
      { title: 'p1', createdById: userId },
      { title: 'p2', createdById: userId },
      { title: 'p3', createdById: otherUserId },
    ]);
    const allowedViewIds = posts.map((post) => post.get('id'));
    const allowedUpdateIds = posts.slice(0, 2).map((post) => post.get('id'));

    // @ts-ignore
    const response = await agent.resource(collectionName).list({});

    const data = response.body;
    expect(data.meta.allowedActions.view).toEqual(allowedViewIds);
    expect(data.meta.allowedActions.update).toEqual(allowedUpdateIds);
    expect(data.meta.allowedActions.destroy).toEqual([]);
  });

  it('should response item permission when request get action', async () => {
    const roleName = 'acl-list-get-meta-role';
    const collectionName = 'aclListGetMetaPosts';
    const Post = await createPostCollection(collectionName);
    const { agent, userId, otherUserId } = await createUserAgent(roleName);

    const userRole = app.acl.define({
      role: roleName,
    });

    userRole.grantAction(`${collectionName}:view`, {});

    userRole.grantAction(`${collectionName}:update`, {
      filter: {
        $and: [{ createdById: '{{ ctx.state.currentUser.id }}' }],
      },
    });

    const [p1] = await Post.model.bulkCreate([
      { title: 'p1', createdById: userId },
      { title: 'p2', createdById: userId },
      { title: 'p3', createdById: otherUserId },
    ]);

    // @ts-ignore
    const getResponse = await agent.resource(collectionName).get({
      filterByTk: p1.get('id'),
    });

    const getBody = getResponse.body;

    expect(getBody.meta.allowedActions).toBeDefined();
  });
});

describe('list association action with acl', () => {
  let app;
  let db: Database;

  beforeAll(async () => {
    app = await prepareApp({
      plugins: aclCollectionManagerTestPlugins,
    });
    db = app.db;

    app.db.collection({
      name: 'posts',
      fields: [
        {
          type: 'string',
          name: 'title',
        },
        {
          type: 'hasMany',
          name: 'comments',
          target: 'comments',
        },
      ],
    });

    app.db.collection({
      name: 'comments',
      fields: [
        {
          type: 'string',
          name: 'content',
        },
        {
          type: 'belongsTo',
          name: 'post',
          target: 'posts',
        },
      ],
    });

    await app.db.sync();
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should list allowedActions', async () => {
    await db.getRepository('roles').create({
      values: {
        name: 'listAssociationRole',
      },
    });

    const user = await db.getRepository('users').create({
      values: {
        roles: ['listAssociationRole'],
      },
    });

    await db.getRepository('roles.resources', 'listAssociationRole').create({
      values: {
        name: 'posts',
        usingActionsConfig: true,
        actions: [
          {
            name: 'view',
            fields: ['title', 'comments'],
          },
          {
            name: 'create',
            fields: ['title', 'comments'],
          },
        ],
      },
    });

    const userAgent = app.agent().login(user).set('X-Role', 'listAssociationRole').set('X-With-ACL-Meta', true);

    const createResponse = await userAgent.resource('posts').create({
      values: {
        title: 'post1',
        comments: [{ content: 'comment1' }, { content: 'comment2' }],
      },
    });
    const postId = createResponse.body.data.id;
    const commentIds = createResponse.body.data.comments.map((comment) => comment.id);

    const response = await userAgent.resource('posts').list({});
    expect(response.statusCode).toEqual(200);

    const commentsResponse = await userAgent.resource('posts.comments', postId).list({});
    const data = commentsResponse.body;

    /**
     * allowedActions.view == commentIds
     * allowedActions.update = []
     * allowedActions.destroy = []
     */
    expect(data['meta']['allowedActions']).toBeDefined();
    expect(data['meta']['allowedActions'].view).toEqual(expect.arrayContaining(commentIds));
  });

  it('tree list action allowActions', async () => {
    await db.getRepository('roles').create({
      values: {
        name: 'treeListAssociationRole',
      },
    });

    const user = await db.getRepository('users').create({
      values: {
        roles: ['treeListAssociationRole'],
      },
    });

    const agent = app.agent().login(user).set('X-Role', 'treeListAssociationRole').set('X-With-ACL-Meta', true);
    app.acl.allow('table_a', ['*']);
    app.acl.allow('collections', ['*']);

    await agent.resource('collections').create({
      values: {
        autoGenId: true,
        createdBy: false,
        updatedBy: false,
        createdAt: false,
        updatedAt: false,
        sortable: false,
        name: 'table_a',
        template: 'tree',
        tree: 'adjacency-list',
        fields: [
          {
            interface: 'integer',
            name: 'parentId',
            type: 'bigInt',
            isForeignKey: true,
            uiSchema: {
              type: 'number',
              title: '{{t("Parent ID")}}',
              'x-component': 'InputNumber',
              'x-read-pretty': true,
            },
            target: 'table_a',
          },
          {
            interface: 'm2o',
            type: 'belongsTo',
            name: 'parent',
            treeParent: true,
            foreignKey: 'parentId',
            uiSchema: {
              title: '{{t("Parent")}}',
              'x-component': 'AssociationField',
              'x-component-props': { multiple: false, fieldNames: { label: 'id', value: 'id' } },
            },
            target: 'table_a',
          },
          {
            interface: 'o2m',
            type: 'hasMany',
            name: 'children',
            foreignKey: 'parentId',
            uiSchema: {
              title: '{{t("Children")}}',
              'x-component': 'RecordPicker',
              'x-component-props': { multiple: true, fieldNames: { label: 'id', value: 'id' } },
            },
            treeChildren: true,
            target: 'table_a',
          },
          {
            name: 'id',
            type: 'bigInt',
            autoIncrement: true,
            primaryKey: true,
            allowNull: false,
            uiSchema: { type: 'number', title: '{{t("ID")}}', 'x-component': 'InputNumber', 'x-read-pretty': true },
            interface: 'id',
          },
        ],
        title: 'table_a',
      },
    });

    await agent.resource('table_a').create({
      values: {},
    });

    await agent.resource('table_a').create({
      values: {
        parent: {
          id: 1,
        },
      },
    });

    await agent.resource('table_a').create({
      values: {},
    });

    await agent.resource('table_a').create({
      values: {
        parent: {
          id: 3,
        },
      },
    });

    const res = await agent.resource('table_a').list({
      filter: JSON.stringify({
        parentId: null,
      }),
      tree: true,
    });

    expect(res.body.meta.allowedActions.view.sort()).toMatchObject([1, 2, 3, 4]);
  });
});
