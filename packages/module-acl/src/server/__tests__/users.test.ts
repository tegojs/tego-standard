import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { aclTestPlugins, prepareApp } from './prepare';

describe('actions', () => {
  let app: MockServer;
  let db: Database;
  let adminUser;
  let agent;
  let adminAgent;
  let originalRootEmail: string | undefined;
  let originalRootPassword: string | undefined;
  let originalRootNickname: string | undefined;

  function restoreEnv(name: string, value: string | undefined) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  beforeAll(async () => {
    originalRootEmail = process.env.INIT_ROOT_EMAIL;
    originalRootPassword = process.env.INIT_ROOT_PASSWORD;
    originalRootNickname = process.env.INIT_ROOT_NICKNAME;

    process.env.INIT_ROOT_EMAIL = 'test@tachybase.com';
    process.env.INIT_ROOT_PASSWORD = '123456';
    process.env.INIT_ROOT_NICKNAME = 'Test';

    app = await prepareApp({
      plugins: aclTestPlugins,
    });
    db = app.db;

    adminUser = await db.getRepository('users').findOne({
      filter: {
        email: process.env.INIT_ROOT_EMAIL,
      },
      appends: ['roles'],
    });

    agent = app.agent();
    adminAgent = app.agent().login(adminUser);
  });

  afterAll(async () => {
    await app.destroy();
    restoreEnv('INIT_ROOT_EMAIL', originalRootEmail);
    restoreEnv('INIT_ROOT_PASSWORD', originalRootPassword);
    restoreEnv('INIT_ROOT_NICKNAME', originalRootNickname);
  });

  it('should set scope with user associations', async () => {
    await app.db.getCollection('collections').repository.create({
      values: {
        name: 'sites',
        autoGenId: false,
        fields: [
          {
            name: 'id',
            type: 'bigInt',
            primaryKey: true,
            autoIncrement: true,
          },
          {
            type: 'string',
            name: 'name',
          },
        ],
      },
      context: {},
    });

    // create site
    const site = await db.getRepository('sites').create({
      values: {
        name: 'testSite',
      },
    });

    const site2 = await db.getRepository('sites').create({
      values: {
        name: 'site2',
      },
    });

    await app.db.getCollection('fields').repository.create({
      values: {
        collectionName: 'users',
        name: 'site',
        type: 'belongsTo',
        foreignKey: 'siteId',
        targetKey: 'id',
      },
      context: {},
    });

    const roleName = 'acl-user-site-role';
    const testUser = await db.getRepository('users').create({
      values: {
        username: 'testUser',
        site: site.get('id'),
      },
    });

    await db.getRepository('roles').create({
      values: {
        name: roleName,
        users: [
          {
            id: testUser.get('id'),
          },
        ],
      },
    });

    await app.db.getCollection('collections').repository.create({
      values: {
        name: 'items',
        fields: [
          {
            type: 'string',
            name: 'name',
          },
          {
            name: 'site',
            type: 'belongsTo',
            foreignKey: 'siteId',
            targetKey: 'id',
          },
        ],
      },
      context: {},
    });

    const scope = await app.db.getCollection('dataSourcesRolesResourcesScopes').repository.create({
      values: {
        name: 'items-own-site',
        actions: ['view'],
        fields: ['name'],
        scope: { $and: [{ site: { id: { $eq: '{{$user.site.id}}' } } }] },
        resourceName: 'items',
      },
    });

    // create acl resource
    const createResourcesResp = await adminAgent.resource('roles.resources', roleName).create({
      values: {
        name: 'items',
        usingActionsConfig: true,
        actions: [
          {
            name: 'view',
            scope: scope.get('id'),
          },
        ],
      },
    });

    expect(createResourcesResp.status).toBe(200);

    await db.getRepository('items').create({
      values: {
        name: 'testItem',
        site: site.get('id'),
      },
    });

    await db.getRepository('items').create({
      values: {
        name: 'item2',
        site: site2.get('id'),
      },
    });

    // list with user
    const userAgent: any = app.agent().login(testUser).set('x-role', roleName);

    const listResp = await userAgent.resource('items').list({});
    expect(listResp.status).toBe(200);
    const data = listResp.body.data;
    expect(data.length).toBe(1);
  });

  it('update profile with roles', async () => {
    const res2 = await adminAgent.resource('users').updateProfile({
      filterByTk: adminUser.id,
      values: {
        nickname: 'a',
        roles: adminUser.roles,
      },
    });
    expect(res2.status).toBe(200);
  });

  it('can destroy users role', async () => {
    const roleName = 'acl-user-destroy-role';
    const email = 'acl-user-destroy@tachybase.com';
    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    await db.getRepository('users').create({
      values: {
        email,
        name: 'test2',
        password: '123456',
        roles: [
          {
            name: roleName,
          },
        ],
      },
    });

    let response = await agent.post('/auth:signIn').send({
      email,
      password: '123456',
    });

    expect(response.statusCode).toEqual(200);

    const token = response.body.data.token;

    const loggedAgent = app.agent().auth(token, { type: 'bearer' });

    const rolesCheckResponse = (await loggedAgent.set('Accept', 'application/json').get('/roles:check')) as any;

    expect(rolesCheckResponse.statusCode).toEqual(200);

    await db.getRepository('roles').destroy({
      filterByTk: roleName,
    });
    await app.cache.reset();

    response = await agent.post('/auth:signIn').send({
      email,
      password: '123456',
    });

    expect(response.statusCode).toEqual(200);

    const rolesCheckResponse2 = (await loggedAgent.set('Accept', 'application/json').get('/roles:check')) as any;

    expect(rolesCheckResponse2.status).toEqual(401);
    expect(rolesCheckResponse2.body.errors[0].code).toEqual('USER_HAS_NO_ROLES_ERR');
  });

  it('should destroy through table record when destroy role', async () => {
    const roleName = 'acl-user-through-role';
    const email = 'acl-user-through@tachybase.com';
    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    const users2 = await db.getRepository('users').create({
      values: {
        email,
        name: 'test2',
        password: '123456',
        roles: [
          {
            name: roleName,
          },
        ],
      },
    });

    expect(await users2.countRoles()).toEqual(1);

    await db.getRepository('roles').destroy({
      filterByTk: roleName,
    });

    expect(await users2.countRoles()).toEqual(0);

    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    expect(await users2.countRoles()).toEqual(0);
  });
});
