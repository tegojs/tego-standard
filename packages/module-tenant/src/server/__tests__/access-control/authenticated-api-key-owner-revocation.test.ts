import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import PluginAPIKeysServer from '../../../../../plugin-api-keys/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated API key owner revocation', () => {
  // An unfiltered token lookup must not revoke another owner's key before a filtered delete does nothing.
  // 删除的最终所有者和请求范围也必须约束拉黑副作用；真正删除仍须撤销原 JWT。
  it('preserves business access after out-of-scope deletes and revokes only the owner-selected key', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const issuer = 'key-revocation-manager';
    const writer = 'key-revocation-writer';
    const name = 'keyOwnerBusinessTasks';
    const password = 'key-owner-test-password';
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [PluginAPIKeysServer, { name: 'api-keys', packageName: '@tachybase/plugin-api-keys', workspaceSource: true }],
        ],
      });
      await app.db.getRepository('tenants').create({
        values: [
          { id: 'B', name: 'B', enabled: true },
          { id: 'C', name: 'C', enabled: true },
        ],
      });
      await app.db.getRepository('roles').create({
        values: [
          { name: issuer, strategy: { actions: [] }, snippets: ['pm.api-keys.configuration'] },
          { name: writer, strategy: { actions: [] }, snippets: [] },
        ],
      });
      const owner = await app.db.getRepository('users').create({
        values: { username: 'key-owner', password, roles: [issuer, writer], tenants: ['B'], defaultTenantId: 'B' },
      });
      const other = await app.db.getRepository('users').create({
        values: { username: 'other-key-manager', password, roles: [issuer], tenants: ['C'], defaultTenantId: 'C' },
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
      const actions = [
        { name: 'create', fields: ['name'] },
        { name: 'destroy', fields: [] },
        { name: 'get', fields: ['id', 'name', 'tenantId'] },
        { name: 'list', fields: ['id', 'name', 'tenantId'] },
        { name: 'update', fields: ['name'] },
      ];
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: { dataSourceKey: 'main', roleName: writer, name, usingActionsConfig: true, actions },
      });
      expect(
        (await resource.getActions())
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(actions);
      const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName: name };
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
              right: { type: 'literal', value: String(owner.id) },
            },
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'context', path: 'role.name' },
              right: { type: 'literal', value: writer },
            },
          ],
        };
      await registry.store.save(identity, { ...config, revision: 0 }, { userId: owner.id });
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      const observed: Array<{ userId: unknown; roleName: unknown; tenantId: unknown }> = [];
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => {
        if (ctx.action.resourceName === name)
          observed.push({
            userId: ctx.state.currentUser?.id,
            roleName: ctx.state.currentRole,
            tenantId: ctx.state.currentTenantId,
          });
        return registry.select(ctx, adapter, [identity.collectionKey]);
      });
      const agent = (token: string, roleName = issuer, tenantId = 'B') =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', roleName)
          .set('X-Tenant-Id', tenantId);
      const sessions: string[] = [];
      for (const [account, userId] of [
        ['key-owner', owner.id],
        ['other-key-manager', other.id],
      ] as const) {
        const signedIn = await app
          .agent()
          .post('/auth:signIn')
          .set('X-Authenticator', 'basic')
          .send({ account, password });
        expect(signedIn.status).toBe(200);
        expect(signedIn.body.data.user).toMatchObject({ id: userId, hasPassword: true });
        sessions.push(signedIn.body.data.token);
      }
      const issued = await agent(sessions[0])
        .resource('apiKeys')
        .create({
          values: { name: 'Owner business key', role: { name: writer }, expiresIn: '1d' },
        });
      expect(issued.status).toBe(200);
      const key = issued.body.data.token;
      expect(key).toMatch(/^[a-f0-9]{64}$/);
      const keys = app.db.getRepository('apiKeys');
      const storedKey = await keys.findOne({ filter: { accessToken: key } });
      expect(storedKey.get('createdById')).toBe(owner.id);
      expect(storedKey.get('roleName')).toBe(writer);
      const keyId = storedKey.get('id');
      const jwt = storedKey.get('token');
      const payload = await app.authManager.jwt.decode(jwt);
      expect(payload).toMatchObject({ userId: owner.id, roleName: writer });
      const business = (token = key) => agent(token).resource(name);
      const checked = await agent(key).get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: owner.id, hasPassword: true });
      const rows = () => app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const created = await business().create({ values: { name: 'Owner task' } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [1], affected: 1 });
      const original = { id: 1, name: 'Owner task', tenantId: 'B' };
      const warm = await business().list();
      expect(warm.status).toBe(200);
      expect(warm.body.data).toEqual([original]);
      expect(await rows()).toEqual([original]);
      expect(observed).toContainEqual({ userId: owner.id, roleName: writer, tenantId: 'B' });
      const blacklist = app.db.getRepository('tokenBlacklist');
      expect(await blacklist.count()).toBe(0);
      const keyRows = () => keys.collection.model.findAll({ raw: true, order: [['id', 'ASC']] });
      const keyBaseline = await keyRows();
      const otherKeys = await agent(sessions[1], issuer, 'C').resource('apiKeys').list();
      expect(otherKeys.status).toBe(200);
      expect(otherKeys.body.data).toEqual([]);
      const foreignDelete = await agent(sessions[1], issuer, 'C')
        .resource('apiKeys')
        .destroy({
          filterByTk: keyId,
          filter: { createdById: owner.id },
        });
      expect(foreignDelete.status).toBe(200);
      expect(foreignDelete.body.data).toBe(0);
      expect(await keyRows()).toEqual(keyBaseline);
      const afterForeignDelete = await business().list();
      expect(afterForeignDelete.status, 'A foreign owner cannot revoke this live business key').toBe(200);
      expect(afterForeignDelete.body.data).toEqual([original]);
      expect(await blacklist.count()).toBe(0);
      const filteredDelete = await agent(sessions[0])
        .resource('apiKeys')
        .destroy({
          filterByTk: keyId,
          filter: { name: 'Not this key' },
        });
      expect(filteredDelete.status).toBe(200);
      expect(filteredDelete.body.data).toBe(0);
      expect(await keyRows()).toEqual(keyBaseline);
      expect(await blacklist.count()).toBe(0);
      const saved = await business().update({ filterByTk: 1, values: { name: 'Still authorized' } });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toEqual({ keys: [1], affected: 1 });
      const finalRow = { id: 1, name: 'Still authorized', tenantId: 'B' };
      expect(await rows()).toEqual([finalRow]);
      const removed = await agent(sessions[0]).resource('apiKeys').destroy({ filterByTk: keyId });
      expect(removed.status).toBe(200);
      expect(removed.body.data).toBe(1);
      expect(await keyRows()).toEqual([]);
      expect(await blacklist.find({ fields: ['token'], raw: true })).toEqual([{ token: jwt }]);
      for (const token of [key, jwt]) {
        const deniedRead = await business(token).list();
        expect(deniedRead.status).toBe(401);
        expect(deniedRead.body).not.toHaveProperty('data');
        const deniedWrite = await business(token).update({ filterByTk: 1, values: { name: 'Revoked' } });
        expect(deniedWrite.status).toBe(401);
        expect(deniedWrite.body).not.toHaveProperty('data');
      }
      expect(await rows()).toEqual([finalRow]);
      const sessionRead = await agent(sessions[0], writer).resource(name).list();
      expect(sessionRead.status).toBe(200);
      expect(sessionRead.body.data).toEqual([finalRow]);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
