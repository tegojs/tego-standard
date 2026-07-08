import { MockServer } from '@tachybase/test';
import { ArrayFieldRepository, Database, Model } from '@tego/server';

import { aclLightTestPlugins, prepareApp } from './prepare';

describe('role api', () => {
  let app: MockServer;
  let db: Database;

  afterAll(async () => {
    await app.destroy();
  });

  beforeAll(async () => {
    app = await prepareApp({
      plugins: aclLightTestPlugins,
    });
    db = app.db;
  });

  describe('grant', () => {
    let role: Model;
    let admin: Model;
    let adminAgent;

    beforeEach(async () => {
      role = await db.getRepository('roles').findOne({
        filter: {
          name: 'admin',
        },
      });

      const UserRepo = db.getCollection('users').repository;
      admin = await UserRepo.create({
        values: {
          roles: ['admin'],
        },
      });

      adminAgent = app.agent().login(admin);
    });

    it('should list actions', async () => {
      const response = await adminAgent.resource('availableActions').list();
      expect(response.statusCode).toEqual(200);
    });

    it('should grant universal role actions', async () => {
      // grant role actions
      const response = await adminAgent.resource('roles').update({
        forceUpdate: true,
        values: {
          strategy: {
            actions: ['create:all', 'view:own'],
          },
        },
      });

      expect(response.statusCode).toEqual(200);

      await role.reload();

      expect(role.get('strategy')).toMatchObject({
        actions: ['create:all', 'view:own'],
      });
    });
  });

  it('should works with default option', async () => {
    const role1Name = 'acl-default-role-1';
    const role2Name = 'acl-default-role-2';
    await db.getRepository('roles').create({
      values: {
        name: role1Name,
        title: 'admin 1',
        default: true,
      },
    });

    await db.getRepository('roles').create({
      values: {
        name: role2Name,
        default: true,
      },
    });

    const defaultRole = await db.getRepository('roles').find({
      filter: {
        default: true,
      },
    });

    expect(defaultRole.length).toEqual(1);
    expect(defaultRole[0].get('name')).toEqual(role2Name);
  });

  it('should sync snippet patterns', async () => {
    const roleName = 'acl-snippet-pattern-role';
    app.acl.registerSnippet({
      name: 'collections',
      actions: ['collection:*'],
    });

    await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    await db.getRepository<ArrayFieldRepository>('roles.snippets', roleName).set({
      values: ['collections'],
    });

    const role1 = app.acl.getRole(roleName);

    expect(role1.toJSON()['snippets']).toEqual(['collections']);
  });
});
