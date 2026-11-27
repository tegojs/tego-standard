import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import { BaseAuth } from '@tego/server';

import PluginShareServer from '../../../../../plugin-action-share/src/server';
import { createTenantApp } from '../utils';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated self-service profile role boundary', () => {
  // Catch a logged-in user adding root membership through a profile edit without user-management permission.
  // 个人资料允许更新自己的昵称，不能顺带改写授权角色；原入口和分享覆写都须保持这个边界。
  it.each([
    { name: 'ordinary user module', share: false },
    { name: 'share plugin override', share: true },
  ])('$name keeps role membership unchanged after a profile edit', async ({ share }) => {
    let app: MockServer;
    const originalCheck = BaseAuth.prototype.check;
    const role = 'profile-member';
    const account = 'profile-member-account';
    const password = 'profile-member-password';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: share
          ? [
              [
                PluginShareServer,
                { name: 'action-share', packageName: '@tachybase/plugin-action-share', workspaceSource: true },
              ],
            ]
          : [],
      });
      await app.db.getRepository('tenants').createMany({
        records: ['B', 'C'].map((id) => ({ id, name: id, enabled: true })),
      });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const users = app.db.getRepository('users');
      const actor = await users.create({
        values: {
          username: account,
          nickname: 'Profile original',
          password,
          roles: [role],
          tenants: ['B'],
          defaultTenantId: 'B',
        },
      });
      await users.create({
        values: {
          username: 'profile-unrelated-account',
          nickname: 'C original',
          roles: [role],
          tenants: ['C'],
          defaultTenantId: 'C',
        },
      });
      const signIn = () => app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
      const login = await signIn();
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: actor.id, hasPassword: true });
      const agent = (token: string, selectedRole = role) =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', selectedRole)
          .set('X-Tenant-Id', 'B');
      const current = () => agent(login.body.data.token);
      const check = await current().get('/auth:check');
      expect(check.status).toBe(200);
      expect(check.body.data).toMatchObject({ id: actor.id, username: account });
      const rolesCheck = await current().get('/roles:check');
      expect(rolesCheck.status).toBe(200);
      expect(rolesCheck.body.data).toMatchObject({ role, allowAll: false });
      const initialRoot = await agent(login.body.data.token, 'root').get('/roles:check');
      expect(initialRoot.status).toBe(401);
      expect(initialRoot.body).not.toHaveProperty('data');
      const denied = await current()
        .resource('users')
        .update({ filterByTk: actor.id, values: { nickname: 'Managed edit' } });
      expect(denied.status).toBe(403);
      expect(denied.body).not.toHaveProperty('data');
      const identities = () =>
        app.db.getCollection('users').model.findAll({
          raw: true,
          attributes: ['id', 'username', 'nickname', 'email', 'specialRole', 'defaultTenantId'],
          order: [['id', 'ASC']],
        });
      const memberships = async () => ({
        roles: await app.db.getCollection('rolesUsers').model.findAll({
          raw: true,
          order: [
            ['userId', 'ASC'],
            ['roleName', 'ASC'],
          ],
        }),
        tenants: await app.db.getCollection('tenantUsers').model.findAll({
          raw: true,
          order: [
            ['userId', 'ASC'],
            ['tenantId', 'ASC'],
          ],
        }),
      });
      const initialIdentities = await identities();
      const initialMemberships = await memberships();
      expect(initialMemberships.roles.filter((row) => row.userId === actor.id).map((row) => row.roleName)).toEqual([
        role,
      ]);
      const saved = await current()
        .resource('users')
        .updateProfile({
          values: { nickname: 'Profile edited', roles: [role, 'root'] },
        });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toHaveLength(1);
      expect(saved.body.data[0]).toMatchObject({ id: actor.id, nickname: 'Profile edited' });
      const escalated = await agent(login.body.data.token, 'root').get('/roles:check');
      expect(escalated.status).toBe(401);
      expect(escalated.body).not.toHaveProperty('data');
      expect(await memberships()).toEqual(initialMemberships);
      const expectedIdentities = initialIdentities.map((row) =>
        row.id === actor.id ? { ...row, nickname: 'Profile edited' } : row,
      );
      expect(await identities()).toEqual(expectedIdentities);
      const relogin = await signIn();
      expect(relogin.status).toBe(200);
      const freshRoot = await agent(relogin.body.data.token, 'root').get('/roles:check');
      expect(freshRoot.status).toBe(401);
      expect(freshRoot.body).not.toHaveProperty('data');
      const retained = await agent(relogin.body.data.token).get('/auth:check');
      expect(retained.status).toBe(200);
      expect(retained.body.data).toMatchObject({ id: actor.id, username: account, nickname: 'Profile edited' });
      expect(await memberships()).toEqual(initialMemberships);
      expect(await identities()).toEqual(expectedIdentities);
    } finally {
      try {
        await app?.destroy();
      } finally {
        BaseAuth.prototype.check = originalCheck;
      }
    }
  });
});
