import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import { BaseAuth } from '@tego/server';

import PluginShareServer from '../../../../../plugin-action-share/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('share plugin authenticated session revocation', () => {
  // Catch the share plugin accepting revoked bearers while preserving anonymous guest access.
  // 分享插件不能绕过原凭据撤销；无凭据访客与正常密码会话仍分别遵守原权限。
  it('rejects a signed-out bearer for tenant business access without falling back to guest', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const originalCheck = BaseAuth.prototype.check;
    const role = 'share-session-editor';
    const name = 'shareSessionTasks';
    const password = 'share-session-password';
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
      // The helper disables automatic ACL installation; its explicit ACL middleware is already active.
      // Restore the production flag so Auth.skipCheck does not bypass anonymous authentication.
      app.options.acl = true;
      const guest = await app.db.getRepository('users').findOne({ filter: { username: 'guest' } });
      expect(guest).toBeTruthy();
      expect(BaseAuth.prototype.check).not.toBe(originalCheck);
      await app.db.getRepository('tenants').createMany({
        records: ['B', 'C'].map((id) => ({ id, name: id, enabled: true })),
      });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
      });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [{ name: 'name', type: 'string' }],
        },
      });
      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name };
      const actions = [
        { name: 'create', fields: ['name'] },
        { name: 'list', fields: ['id', 'name', 'tenantId'] },
        { name: 'update', fields: ['name'] },
      ];
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: { dataSourceKey: 'main', roleName: role, name, usingActionsConfig: true, actions },
      });
      expect(
        (await resource.getActions())
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(actions);
      const registry = new AccessMainRootResourceRegistry(app);
      await app.db.collection(accessConfigHistory).model.sync();
      const config = configFor(ownerCondition);
      for (const rule of config.rules)
        rule.subject = {
          type: 'all',
          children: [
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'context', path: 'user.id' },
              right: { type: 'literal', value: String(user.id) },
            },
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'context', path: 'role.name' },
              right: { type: 'literal', value: role },
            },
          ],
        };
      await registry.store.save(identity, { ...config, revision: 0 }, { userId: user.id });
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, [identity.collectionKey]),
      );
      const signIn = () =>
        app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account: role, password });
      const agent = (token: string, tenant = 'B') =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', tenant);
      const anonymous = () => app.agent().set('X-Authenticator', 'basic').set('X-Role', 'guest');
      const guestCheck = await anonymous().get('/auth:check');
      expect(guestCheck.status, JSON.stringify(guestCheck.body.errors)).toBe(200);
      expect(guestCheck.body.data).toMatchObject({ id: guest.id, username: 'guest' });
      const login = await signIn();
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const token = login.body.data.token;
      const payload = await app.authManager.jwt.decode(token);
      expect(payload).toMatchObject({ userId: user.id, temp: true });
      expect(typeof payload.jti).toBe('string');
      const checked = await agent(token).get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id });
      const created = await agent(token)
        .resource(name)
        .create({ values: { name: 'Before logout' } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [1], affected: 1 });
      const rows = () => app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
      const original = { id: 1, name: 'Before logout', tenantId: 'B' };
      expect(await rows()).toEqual([original]);
      const warmed = await agent(token).resource(name).list();
      expect(warmed.status).toBe(200);
      expect(warmed.body.data).toEqual([original]);
      const signedOut = await agent(token).post('/auth:signOut');
      expect(signedOut.status).toBe(200);
      const revoked = () =>
        app.db.getRepository('tokenBlacklist').find({ filter: { token: payload.jti }, fields: ['token'], raw: true });
      expect(await revoked()).toEqual([{ token: payload.jti }]);
      const rejectedRead = await agent(token).resource(name).list();
      expect(rejectedRead.status).toBe(401);
      expect(rejectedRead.body).not.toHaveProperty('data');
      const rejectedWrite = await agent(token)
        .resource(name)
        .update({ filterByTk: 1, values: { name: 'Revoked edit' } });
      expect(rejectedWrite.status).toBe(401);
      expect(rejectedWrite.body).not.toHaveProperty('data');
      const rejectedCheck = await agent(token).get('/auth:check');
      expect(rejectedCheck.status).toBe(401);
      expect(rejectedCheck.body).not.toHaveProperty('data');
      expect(await rows()).toEqual([original]);
      const guestAfter = await anonymous().get('/auth:check');
      expect(guestAfter.status).toBe(200);
      expect(guestAfter.body.data).toMatchObject({ id: guest.id, username: 'guest' });
      const guestRead = await anonymous().set('X-Tenant-Id', 'B').resource(name).list();
      expect(guestRead.status).toBe(403);
      expect(guestRead.body).not.toHaveProperty('data');
      const nextLogin = await signIn();
      expect(nextLogin.status).toBe(200);
      const freshToken = nextLogin.body.data.token;
      expect(freshToken).not.toBe(token);
      const freshList = await agent(freshToken).resource(name).list();
      expect(freshList.status).toBe(200);
      expect(freshList.body.data).toEqual([original]);
      const crossTenant = await agent(freshToken, 'C').resource(name).list();
      expect(crossTenant.status).toBe(403);
      expect(crossTenant.body).not.toHaveProperty('data');
      const saved = await agent(freshToken)
        .resource(name)
        .update({ filterByTk: 1, values: { name: 'Fresh edit' } });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([{ id: 1, name: 'Fresh edit', tenantId: 'B' }]);
      expect(await revoked()).toEqual([{ token: payload.jti }]);
    } finally {
      unregister?.();
      try {
        await app?.destroy();
      } finally {
        BaseAuth.prototype.check = originalCheck;
      }
    }
  });
});
