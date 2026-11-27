import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import { BaseAuth } from '@tego/server';

import PluginShareServer from '../../../../../plugin-action-share/src/server';
import { createTenantApp } from '../utils';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('share plugin authenticated account field permissions', () => {
  // Catch a nickname-only maintainer resetting another account's password through users:update.
  // 同一目标的数据范围命中，不代表维护角色获准修改密码；明确授予密码字段后才可重置。
  it('keeps the existing password for nickname-only updates and permits an explicitly authorized reset', async () => {
    let app: MockServer;
    const originalCheck = BaseAuth.prototype.check;
    const nicknameRole = 'share-nickname-maintainer';
    const passwordRole = 'share-password-maintainer';
    const memberRole = 'share-password-member';
    const actorAccount = 'share-field-operator';
    const targetAccount = 'share-field-target';
    const actorPassword = 'share-field-operator-password';
    const originalPassword = 'share-field-original-password';
    const replacementPassword = 'share-field-replacement-password';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [
            PluginShareServer,
            { name: 'action-share', packageName: '@tachybase/plugin-action-share', workspaceSource: true },
          ],
        ],
      });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      for (const name of [nicknameRole, passwordRole, memberRole])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const users = app.db.getRepository('users');
      const actor = await users.create({
        values: {
          username: actorAccount,
          password: actorPassword,
          roles: [nicknameRole, passwordRole],
          tenants: ['B'],
          defaultTenantId: 'B',
        },
      });
      const target = await users.create({
        values: {
          username: targetAccount,
          nickname: 'Original nickname',
          password: originalPassword,
          roles: [memberRole],
          tenants: ['B'],
          defaultTenantId: 'B',
        },
      });
      const filter = { id: { $eq: target.id } };
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: { dataSourceKey: 'main', resourceName: 'users', name: 'Assigned field target', scope: filter },
      });
      for (const [roleName, field] of [
        [nicknameRole, 'nickname'],
        [passwordRole, 'password'],
      ]) {
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName,
            name: 'users',
            usingActionsConfig: true,
            actions: [{ name: 'update', fields: [field], scope: { id: scope.get('id') } }],
          },
        });
        const actions = await resource.getActions({ include: ['scope'] });
        expect(actions).toHaveLength(1);
        expect(actions[0].get('name')).toBe('update');
        expect(actions[0].get('fields')).toEqual([field]);
        expect(actions[0].get('scope')?.get('scope')).toEqual(filter);
      }
      const signIn = (account: string, password: string) =>
        app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
      const login = await signIn(actorAccount, actorPassword);
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: actor.id, hasPassword: true });
      const agent = (token: string, role: string) =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', 'B');
      const operator = (role = nicknameRole) => agent(login.body.data.token, role);
      const checked = await operator().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: actor.id });
      const beforeLogin = await signIn(targetAccount, originalPassword);
      expect(beforeLogin.status).toBe(200);
      expect(beforeLogin.body.data.user).toMatchObject({ id: target.id, hasPassword: true });
      const identities = () =>
        app.db.getCollection('users').model.findAll({
          raw: true,
          attributes: ['id', 'username', 'nickname', 'email', 'specialRole', 'defaultTenantId'],
          order: [['id', 'ASC']],
        });
      const credential = () => users.findOne({ filterByTk: target.id, fields: ['password'], raw: true });
      const memberships = async () => ({
        tenants: await app.db.getCollection('tenantUsers').model.findAll({
          raw: true,
          order: [
            ['userId', 'ASC'],
            ['tenantId', 'ASC'],
          ],
        }),
        roles: await app.db.getCollection('rolesUsers').model.findAll({
          raw: true,
          order: [
            ['userId', 'ASC'],
            ['roleName', 'ASC'],
          ],
        }),
      });
      const initialIdentities = await identities();
      const initialCredential = await credential();
      const initialMemberships = await memberships();
      expect(initialCredential.password).not.toBe(originalPassword);
      const saved = await operator()
        .resource('users')
        .update({ filterByTk: target.id, values: { nickname: 'Maintained nickname', password: replacementPassword } });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toHaveLength(1);
      expect(saved.body.data[0]).toMatchObject({ id: target.id, nickname: 'Maintained nickname' });
      const unauthorizedLogin = await signIn(targetAccount, replacementPassword);
      expect(unauthorizedLogin.status).toBe(401);
      expect(unauthorizedLogin.body).not.toHaveProperty('data');
      expect(await credential()).toEqual(initialCredential);
      const retainedLogin = await signIn(targetAccount, originalPassword);
      expect(retainedLogin.status).toBe(200);
      expect(retainedLogin.body.data.user).toMatchObject({ id: target.id, hasPassword: true });
      const expectedIdentities = initialIdentities.map((row) =>
        row.id === target.id ? { ...row, nickname: 'Maintained nickname' } : row,
      );
      expect(await identities()).toEqual(expectedIdentities);
      expect(await memberships()).toEqual(initialMemberships);
      const reset = await operator(passwordRole)
        .resource('users')
        .update({
          filterByTk: target.id,
          values: { password: replacementPassword, nickname: 'Unauthorized reset nickname' },
        });
      expect(reset.status).toBe(200);
      expect(reset.body.data).toHaveLength(1);
      expect(reset.body.data[0]).toMatchObject({ id: target.id, nickname: 'Maintained nickname' });
      const newLogin = await signIn(targetAccount, replacementPassword);
      expect(newLogin.status).toBe(200);
      expect(newLogin.body.data.user).toMatchObject({ id: target.id, hasPassword: true });
      const targetCheck = await agent(newLogin.body.data.token, memberRole).get('/auth:check');
      expect(targetCheck.status).toBe(200);
      expect(targetCheck.body.data).toMatchObject({ id: target.id, username: targetAccount });
      const oldLogin = await signIn(targetAccount, originalPassword);
      expect(oldLogin.status).toBe(401);
      expect(oldLogin.body).not.toHaveProperty('data');
      expect((await credential()).password).not.toBe(initialCredential.password);
      expect((await credential()).password).not.toBe(replacementPassword);
      expect(await identities()).toEqual(expectedIdentities);
      expect(await memberships()).toEqual(initialMemberships);
    } finally {
      try {
        await app?.destroy();
      } finally {
        BaseAuth.prototype.check = originalCheck;
      }
    }
  });
});
