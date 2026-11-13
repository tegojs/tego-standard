import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated business access after sign-out', () => {
  // Catch reused authentication after logout and account-wide rejection instead of token revocation.
  // 退出后旧凭据不能借预热身份继续读写；同账号重新密码登录仍须按原业务授权工作。
  it('rejects the signed-out bearer for business CRUD and accepts a fresh password login', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const role = 'signout-business-editor';
    const name = 'signedInBusinessTasks';
    const password = 'signout-business-password';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
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
        { name: 'destroy', fields: [] },
        { name: 'get', fields: ['id', 'name', 'tenantId'] },
        { name: 'list', fields: ['id', 'name', 'tenantId'] },
        { name: 'update', fields: ['name'] },
      ];
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: { dataSourceKey: 'main', roleName: role, name, usingActionsConfig: true, actions },
      });
      expect(
        (await resource.getActions())
          .map((action) => ({
            name: action.get('name'),
            fields: [...action.get('fields')].sort(),
          }))
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
      const agent = (token: string) =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role)
          .set('X-Tenant-Id', 'B');
      const first = await signIn();
      expect(first.status).toBe(200);
      expect(first.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const oldToken = first.body.data.token;
      const payload = await app.authManager.jwt.decode(oldToken);
      expect(payload).toMatchObject({ userId: user.id, temp: true });
      expect(typeof payload.jti).toBe('string');
      const checked = await agent(oldToken).get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = () => app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const created = await agent(oldToken)
        .resource(name)
        .create({ values: { name: 'Before sign-out' } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [1], affected: 1 });
      const original = { id: 1, name: 'Before sign-out', tenantId: 'B' };
      expect(await rows()).toEqual([original]);
      const warmed = await agent(oldToken)
        .resource(name)
        .list({ sort: ['id'] });
      expect(warmed.status).toBe(200);
      expect(warmed.body.data).toEqual([original]);
      const blacklist = app.db.getRepository('tokenBlacklist');
      const revoked = () => blacklist.find({ filter: { token: payload.jti }, fields: ['token'], raw: true });
      expect(await revoked()).toEqual([]);
      const signedOut = await agent(oldToken).post('/auth:signOut');
      expect(signedOut.status).toBe(200);
      expect(await revoked()).toEqual([{ token: payload.jti }]);
      expect(await app.authManager.jwt.blacklist.has(payload.jti!)).toBe(true);
      const rejected = [
        await agent(oldToken).get('/auth:check'),
        await agent(oldToken).resource(name).list(),
        await agent(oldToken).resource(name).get({ filterByTk: 1 }),
        await agent(oldToken)
          .resource(name)
          .create({ values: { name: 'Rejected create' } }),
        await agent(oldToken)
          .resource(name)
          .update({ filterByTk: 1, values: { name: 'Rejected update' } }),
        await agent(oldToken).resource(name).destroy({ filterByTk: 1 }),
      ];
      for (const response of rejected) {
        expect(response.status).toBe(401);
        expect(response.body).not.toHaveProperty('data');
      }
      expect(await rows()).toEqual([original]);
      const nextLogin = await signIn();
      expect(nextLogin.status).toBe(200);
      expect(nextLogin.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      const freshToken = nextLogin.body.data.token;
      expect(freshToken).not.toBe(oldToken);
      const freshPayload = await app.authManager.jwt.decode(freshToken);
      expect(freshPayload.userId).toBe(user.id);
      expect(freshPayload.jti).not.toBe(payload.jti);
      const freshCheck = await agent(freshToken).get('/auth:check');
      expect(freshCheck.status).toBe(200);
      expect(freshCheck.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const freshList = await agent(freshToken)
        .resource(name)
        .list({ sort: ['id'] });
      expect(freshList.status).toBe(200);
      expect(freshList.body.data).toEqual([original]);
      const saved = await agent(freshToken)
        .resource(name)
        .update({ filterByTk: 1, values: { name: 'After fresh sign-in' } });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toEqual({ keys: [1], affected: 1 });
      const added = await agent(freshToken)
        .resource(name)
        .create({ values: { name: 'New session task' } });
      expect(added.status).toBe(200);
      expect(added.body.data).toEqual({ keys: [2], affected: 1 });
      const expected = [
        { id: 1, name: 'After fresh sign-in', tenantId: 'B' },
        { id: 2, name: 'New session task', tenantId: 'B' },
      ];
      expect(await rows()).toEqual(expected);
      const finalList = await agent(freshToken)
        .resource(name)
        .list({ sort: ['id'] });
      expect(finalList.status).toBe(200);
      expect(finalList.body.data).toEqual(expected);
      const stillRejected = await agent(oldToken).resource(name).destroy({ filterByTk: 2 });
      expect(stillRejected.status).toBe(401);
      expect(stillRejected.body).not.toHaveProperty('data');
      expect(await rows()).toEqual(expected);
      expect(await revoked()).toEqual([{ token: payload.jti }]);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
