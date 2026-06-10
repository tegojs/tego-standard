import { MockServer } from '@tachybase/test';
import { Database } from '@tego/server';

import { aclCollectionManagerTestPlugins, prepareApp } from './prepare';

describe('configuration', () => {
  let app: MockServer;
  let db: Database;
  let admin;
  let adminAgent;
  let user;
  let userAgent;
  let guestAgent;

  beforeAll(async () => {
    app = await prepareApp({
      plugins: aclCollectionManagerTestPlugins,
    });
    db = app.db;

    await db.getRepository('roles').create({
      values: {
        name: 'test1',
        snippets: ['pm.*'],
      },
    });

    await db.getRepository('roles').create({
      values: {
        name: 'test2',
      },
    });

    const UserRepo = db.getCollection('users').repository;
    admin = await UserRepo.create({
      values: {
        roles: ['test1'],
      },
    });
    user = await UserRepo.create({
      values: {
        roles: ['test2'],
      },
    });

    const userPlugin = app.pm.get('users') as UsersPlugin;
    adminAgent = app.agent().login(admin);

    userAgent = app.agent().login(user);

    guestAgent = app.agent();
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should list collections', async () => {
    expect((await userAgent.resource('collections').create()).statusCode).toEqual(403);
    expect((await userAgent.resource('collections').list()).statusCode).toEqual(200);
  });

  it('should not create/list collections', async () => {
    expect((await guestAgent.resource('collections').create()).statusCode).toEqual(401);
    expect((await guestAgent.resource('collections').list()).statusCode).toEqual(401);
  });

  it('should allow when role has allowConfigure with true value', async () => {
    expect((await adminAgent.resource('collections').create()).statusCode).toEqual(200);
    expect((await adminAgent.resource('collections').list()).statusCode).toEqual(200);
  });
});
