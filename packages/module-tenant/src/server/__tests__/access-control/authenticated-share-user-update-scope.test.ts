import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import { BaseAuth } from '@tego/server';

import PluginShareServer from '../../../../../plugin-action-share/src/server';
import { createTenantApp } from '../utils';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('share plugin authenticated user maintenance scope', () => {
  // Catch the custom users:update handler discarding the final ACL filter.
  // 即使知道另一租户用户的主键，受限维护角色也不能跳过最终用户管理范围。
  it('updates the permitted account and leaves an out-of-scope account unchanged', async () => {
    let app: MockServer;
    const originalCheck = BaseAuth.prototype.check;
    const manager = 'share-user-manager';
    const reader = 'share-user-reader';
    const password = 'share-user-manager-password';
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
      await app.db
        .getRepository('tenants')
        .createMany({ records: ['B', 'C'].map((id) => ({ id, name: id, enabled: true })) });
      for (const name of [manager, reader])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const users = app.db.getRepository('users');
      const actor = await users.create({
        values: { username: manager, password, roles: [manager, reader], tenants: ['B'], defaultTenantId: 'B' },
      });
      const allowed = await users.create({
        values: {
          username: 'managed-b-user',
          nickname: 'B original',
          roles: [reader],
          tenants: ['B'],
          defaultTenantId: 'B',
        },
      });
      const hidden = await users.create({
        values: {
          username: 'managed-c-user',
          nickname: 'C original',
          roles: [reader],
          tenants: ['C'],
          defaultTenantId: 'C',
        },
      });
      const filter = { id: { $eq: allowed.id } };
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: { dataSourceKey: 'main', resourceName: 'users', name: 'Assigned account only', scope: filter },
      });
      for (const roleName of [manager, reader]) {
        const actions = [
          { name: 'list', fields: ['id', 'nickname', 'username'], scope: { id: scope.get('id') } },
          ...(roleName === manager ? [{ name: 'update', fields: ['nickname'], scope: { id: scope.get('id') } }] : []),
        ];
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: { dataSourceKey: 'main', roleName, name: 'users', usingActionsConfig: true, actions },
        });
        expect(
          (await resource.getActions({ include: ['scope'] }))
            .map((action) => ({
              name: action.get('name'),
              fields: [...action.get('fields')].sort(),
              scope: action.get('scope')?.get('scope'),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual(actions.map((action) => ({ name: action.name, fields: action.fields, scope: filter })));
      }
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: manager, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: actor.id, hasPassword: true });
      const agent = (role = manager, tenant = 'B') =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + login.body.data.token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', tenant);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: actor.id });
      const rows = () =>
        app.db.getCollection('users').model.findAll({
          raw: true,
          attributes: ['id', 'username', 'nickname', 'email', 'specialRole', 'defaultTenantId'],
          order: [['id', 'ASC']],
        });
      const members = () =>
        app.db.getCollection('tenantUsers').model.findAll({
          raw: true,
          order: [
            ['userId', 'ASC'],
            ['tenantId', 'ASC'],
          ],
        });
      const initialRows = await rows();
      const initialMembers = await members();
      expect(initialRows.find((row) => row.id === allowed.id)).toMatchObject({
        username: 'managed-b-user',
        nickname: 'B original',
        defaultTenantId: 'B',
      });
      expect(initialRows.find((row) => row.id === hidden.id)).toMatchObject({
        username: 'managed-c-user',
        nickname: 'C original',
        defaultTenantId: 'C',
      });
      const list = await agent()
        .resource('users')
        .list({ sort: ['id'] });
      expect(list.status).toBe(200);
      expect(list.body.data.map((row) => row.id)).toEqual([allowed.id]);
      for (const filterByTk of [undefined, 'invalid', 0]) {
        const invalidTarget = await agent()
          .resource('users')
          .update({ filterByTk, values: { nickname: 'Invalid target edit' } });
        expect(invalidTarget.status).toBeGreaterThanOrEqual(400);
        expect(invalidTarget.body).not.toHaveProperty('data');
        expect(await rows()).toEqual(initialRows);
      }
      const attempted = await agent()
        .resource('users')
        .update({ filterByTk: hidden.id, values: { nickname: 'Out-of-scope edit' } });
      expect(attempted.status).toBe(200);
      expect(await rows()).toEqual(initialRows);
      expect(attempted.body.data).toEqual([]);
      expect(await members()).toEqual(initialMembers);
      const saved = await agent()
        .resource('users')
        .update({ filterByTk: allowed.id, values: { nickname: 'B maintained' } });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toHaveLength(1);
      expect(saved.body.data[0]).toMatchObject({ id: allowed.id, nickname: 'B maintained' });
      const expectedRows = initialRows.map((row) =>
        row.id === allowed.id ? { ...row, nickname: 'B maintained' } : row,
      );
      expect(await rows()).toEqual(expectedRows);
      const deniedRole = await agent(reader)
        .resource('users')
        .update({ filterByTk: allowed.id, values: { nickname: 'Reader edit' } });
      expect(deniedRole.status).toBe(403);
      expect(deniedRole.body).not.toHaveProperty('data');
      const crossTenant = await agent(manager, 'C')
        .resource('users')
        .update({ filterByTk: allowed.id, values: { nickname: 'Forged tenant edit' } });
      expect(crossTenant.status).toBe(403);
      expect(crossTenant.body).not.toHaveProperty('data');
      const finalList = await agent()
        .resource('users')
        .list({ sort: ['id'] });
      expect(finalList.status).toBe(200);
      expect(finalList.body.data).toHaveLength(1);
      expect(finalList.body.data[0]).toMatchObject({
        id: allowed.id,
        username: 'managed-b-user',
        nickname: 'B maintained',
      });
      expect(await rows()).toEqual(expectedRows);
      expect(await members()).toEqual(initialMembers);
    } finally {
      try {
        await app?.destroy();
      } finally {
        BaseAuth.prototype.check = originalCheck;
      }
    }
  });
});
