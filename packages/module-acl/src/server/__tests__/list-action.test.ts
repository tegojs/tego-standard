import { MockServer } from '@tachybase/test';
import { Database } from '@tego/server';

import { prepareApp } from './prepare';

describe('list action with acl', () => {
  let app: MockServer;

  let Post;

  beforeEach(async () => {
    app = await prepareApp();

    Post = app.db.collection({
      name: 'posts',
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
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('should list with meta permission that has difference primary key', async () => {
    app.acl.addFixedParams('tests', 'destroy', () => {
      return {
        filter: {
          $and: [{ 'name.$ne': 't1' }, { 'name.$ne': 't2' }],
        },
      };
    });

    await app.db.getRepository('roles').create({
      values: {
        name: 'user',
      },
    });

    const Test = app.db.collection({
      name: 'tests',
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

    const user = await app.db.getRepository('users').create({
      values: {
        roles: ['user'],
      },
    });
    const otherUser = await app.db.getRepository('users').create({
      values: {},
    });
    const userId = user.get('id');
    const otherUserId = otherUser.get('id');

    const userRole = app.acl.define({
      role: 'user',
    });

    userRole.grantAction('tests:view', {});

    userRole.grantAction('tests:update', {
      filter: {
        $and: [{ createdById: '{{ ctx.state.currentUser.id }}' }],
      },
    });

    userRole.grantAction('tests:destroy', {});

    await Test.model.bulkCreate([
      { name: 't1', createdById: userId },
      { name: 't2', createdById: userId },
      { name: 't3', createdById: otherUserId },
    ]);

    //@ts-ignore
    const response = await app
      .agent()
      .login(user)
      .set('X-Role', 'user')
      .set('X-With-ACL-Meta', true)
      .resource('tests')
      .list({});

    const data = response.body;
    expect(data.meta.allowedActions.view).toEqual(['t1', 't2', 't3']);
    expect(data.meta.allowedActions.update).toEqual(['t1', 't2']);
    expect(data.meta.allowedActions.destroy).toEqual(['t3']);
  });

  it('should list items meta permissions by association field', async () => {
    await app.db.getRepository('roles').create({
      values: {
        name: 'user',
      },
    });

    const user = await app.db.getRepository('users').create({
      values: {
        roles: ['user'],
      },
    });
    const otherUser = await app.db.getRepository('users').create({
      values: {},
    });
    const userId = user.get('id');
    const otherUserId = otherUser.get('id');

    const userRole = app.acl.define({
      role: 'user',
    });

    userRole.grantAction('posts:view', {});

    userRole.grantAction('posts:update', {
      filter: {
        $and: [{ createdById: '{{ ctx.state.currentUser.id }}' }],
      },
    });

    await Post.model.bulkCreate([
      { title: 'p1', createdById: userId },
      { title: 'p2', createdById: userId },
      { title: 'p3', createdById: otherUserId },
    ]);

    const response = await (app as any)
      .agent()
      .login(user)
      .set('X-Role', 'user')
      .set('X-With-ACL-Meta', true)
      .resource('posts')
      .list();
    const data = response.body;
    expect(data.meta.allowedActions.view).toEqual([1, 2, 3]);
    expect(data.meta.allowedActions.update).toEqual([1, 2]);
    expect(data.meta.allowedActions.destroy).toEqual([]);
  });

  it('should list items with meta permission', async () => {
    await app.db.getRepository('roles').create({
      values: {
        name: 'user',
      },
    });

    const user = await app.db.getRepository('users').create({
      values: {
        roles: ['user'],
      },
    });
    const otherUser = await app.db.getRepository('users').create({
      values: {},
    });
    const userId = user.get('id');
    const otherUserId = otherUser.get('id');

    const userRole = app.acl.define({
      role: 'user',
    });

    userRole.grantAction('posts:view', {});

    userRole.grantAction('posts:update', {
      filter: {
        $and: [{ createdById: '{{ ctx.state.currentUser.id }}' }],
      },
    });

    await Post.model.bulkCreate([
      { title: 'p1', createdById: userId },
      { title: 'p2', createdById: userId },
      { title: 'p3', createdById: otherUserId },
    ]);

    // @ts-ignore
    const response = await app
      .agent()
      .login(user)
      .set('X-Role', 'user')
      .set('X-With-ACL-Meta', true)
      .resource('posts')
      .list({});

    const data = response.body;
    expect(data.meta.allowedActions.view).toEqual([1, 2, 3]);
    expect(data.meta.allowedActions.update).toEqual([1, 2]);
    expect(data.meta.allowedActions.destroy).toEqual([]);
  });

  it('should response item permission when request get action', async () => {
    await app.db.getRepository('roles').create({
      values: {
        name: 'user',
      },
    });

    const user = await app.db.getRepository('users').create({
      values: {
        roles: ['user'],
      },
    });
    const otherUser = await app.db.getRepository('users').create({
      values: {},
    });
    const userId = user.get('id');
    const otherUserId = otherUser.get('id');

    const userRole = app.acl.define({
      role: 'user',
    });

    userRole.grantAction('posts:view', {});

    userRole.grantAction('posts:update', {
      filter: {
        $and: [{ createdById: '{{ ctx.state.currentUser.id }}' }],
      },
    });

    await Post.model.bulkCreate([
      { title: 'p1', createdById: userId },
      { title: 'p2', createdById: userId },
      { title: 'p3', createdById: otherUserId },
    ]);

    // @ts-ignore
    const getResponse = await app
      .agent()
      .login(user)
      .set('X-Role', 'user')
      .set('X-With-ACL-Meta', true)
      .resource('posts')
      .get({
        filterByTk: 1,
      });

    const getBody = getResponse.body;

    expect(getBody.meta.allowedActions).toBeDefined();
  });
});

describe('list association action with acl', () => {
  let app;
  let db: Database;

  afterEach(async () => {
    await app.destroy();
  });

  beforeEach(async () => {
    app = await prepareApp();
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

  it('should list allowedActions', async () => {
    await db.getRepository('roles').create({
      values: {
        name: 'newRole',
      },
    });

    const user = await db.getRepository('users').create({
      values: {
        roles: ['newRole'],
      },
    });

    await db.getRepository('roles.resources', 'newRole').create({
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

    const userPlugin = app.pm.get('users');
    const userAgent = app.agent().login(user).set('X-Role', 'newRole').set('X-With-ACL-Meta', true);

    await userAgent.resource('posts').create({
      values: {
        title: 'post1',
        comments: [{ content: 'comment1' }, { content: 'comment2' }],
      },
    });

    const response = await userAgent.resource('posts').list({});
    expect(response.statusCode).toEqual(200);

    const commentsResponse = await userAgent.resource('posts.comments', 1).list({});
    const data = commentsResponse.body;

    /**
     * allowedActions.view == [1]
     * allowedActions.update = []
     * allowedActions.destroy = []
     */
    expect(data['meta']['allowedActions']).toBeDefined();
    expect(data['meta']['allowedActions'].view).toContain(1);
    expect(data['meta']['allowedActions'].view).toContain(2);
  });

  it('tree list action allowActions', async () => {
    await db.getRepository('roles').create({
      values: {
        name: 'newRole',
      },
    });

    const user = await db.getRepository('users').create({
      values: {
        roles: ['newRole'],
      },
    });

    const userPlugin = app.pm.get('users');
    const agent = app.agent().login(user).set('X-Role', 'newRole').set('X-With-ACL-Meta', true);
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
