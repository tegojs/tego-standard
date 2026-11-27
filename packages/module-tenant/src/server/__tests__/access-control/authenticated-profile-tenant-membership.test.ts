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

describe.skipIf(!coreEntry)('authenticated profile tenant access boundary', () => {
  // Profile updates must not grant membership or rewrite hierarchy to open another tenant's business rows.
  // 资料编辑不能自建成员关系或改租户树；原用户入口和分享覆写均须保留原业务读取边界。
  it.each([
    { name: 'ordinary user module', share: false, nestedHierarchy: false },
    { name: 'share plugin override', share: true, nestedHierarchy: false },
    { name: 'ordinary user module through default tenant children', share: false, nestedHierarchy: true },
    { name: 'share plugin override through default tenant children', share: true, nestedHierarchy: true },
    { name: 'ordinary user module with an inaccessible persisted default', share: false, invalidDefault: true },
    { name: 'share plugin override with an inaccessible persisted default', share: true, invalidDefault: true },
  ])('$name remains tenant-scoped after a profile update', async (scenario) => {
    const { share, nestedHierarchy, invalidDefault = false } = scenario;
    let app: MockServer;
    let unregister: (() => void) | undefined;
    const originalCheck = BaseAuth.prototype.check;
    const role = 'profile-tenant-editor';
    const name = 'profileTenantTasks';
    const password = 'profile-tenant-password';
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
      await app.db
        .getRepository('tenants')
        .createMany({ records: ['B', 'C'].map((id) => ({ id, name: id, enabled: true })) });
      await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
      const users = app.db.getRepository('users');
      const actor = await users.create({
        values: {
          username: 'profile-tenant-b',
          nickname: 'B original',
          password,
          roles: [role],
          tenants: ['B'],
          defaultTenantId: 'B',
        },
      });
      const other = await users.create({
        values: {
          username: 'profile-tenant-c',
          nickname: 'C original',
          password,
          roles: [role],
          tenants: ['C'],
          defaultTenantId: 'C',
        },
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
      ];
      const resource = await app.db
        .getRepository('dataSourcesRolesResources')
        .create({ values: { dataSourceKey: 'main', roleName: role, name, usingActionsConfig: true, actions } });
      expect(
        (await resource.getActions())
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(actions);
      const signIn = (account: string) =>
        app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({ account, password });
      const login = await signIn('profile-tenant-b');
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: actor.id, hasPassword: true });
      const otherLogin = await signIn('profile-tenant-c');
      expect(otherLogin.status).toBe(200);
      expect(otherLogin.body.data.user).toMatchObject({ id: other.id, hasPassword: true });
      const agent = (token: string, tenant: string | null = 'B') => {
        const request = app
          .agent()
          .set('Authorization', 'Bearer ' + token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', role);
        return tenant === null ? request : request.set('X-Tenant-Id', tenant);
      };
      const current = (tenant = 'B') => agent(login.body.data.token, tenant);
      const checked = await current().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: actor.id });
      // Seed harmless rows through the original authorized HTTP writer before selecting the new reader.
      const createdB = await current()
        .resource(name)
        .create({ values: { name: 'B private task' } });
      expect(createdB.status).toBe(200);
      const createdC = await agent(otherLogin.body.data.token, 'C')
        .resource(name)
        .create({ values: { name: 'C private task' } });
      expect(createdC.status).toBe(200);
      const rows = () => app.db.getCollection(name).model.findAll({ raw: true, order: [['id', 'ASC']] });
      const originalRows = [
        { id: 1, name: 'B private task', tenantId: 'B' },
        { id: 2, name: 'C private task', tenantId: 'C' },
      ];
      expect(await rows()).toEqual(originalRows);
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
              right: { type: 'literal', value: String(actor.id) },
            },
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'context', path: 'role.name' },
              right: { type: 'literal', value: role },
            },
          ],
        };
      await registry.store.save(identity, { ...config, revision: 0 }, { userId: actor.id });
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
        registry.select(ctx, adapter, [identity.collectionKey]),
      );
      const before = await current().resource(name).list();
      expect(before.status).toBe(200);
      expect(before.body.data).toEqual([originalRows[0]]);
      const initialForeign = await current('C').resource(name).list();
      expect(initialForeign.status).toBe(403);
      expect(initialForeign.body).not.toHaveProperty('data');
      const deniedManagement = await current()
        .resource('tenantUsers')
        .create({ values: { userId: actor.id, tenantId: 'C' } });
      expect(deniedManagement.status).toBe(403);
      expect(deniedManagement.body).not.toHaveProperty('data');
      const deniedHierarchy = await current()
        .resource('tenants')
        .update({ filterByTk: 'C', values: { parentId: 'B' } });
      expect(deniedHierarchy.status).toBe(403);
      expect(deniedHierarchy.body).not.toHaveProperty('data');
      const tenantRows = () => app.db.getCollection('tenants').model.findAll({ raw: true, order: [['id', 'ASC']] });
      const initialTenants = await tenantRows();
      expect(initialTenants.find((row) => row.id === 'C')).toMatchObject({ parentId: null });
      const identities = () =>
        app.db.getCollection('users').model.findAll({
          raw: true,
          attributes: ['id', 'username', 'nickname', 'email', 'specialRole', 'defaultTenantId'],
          order: [['id', 'ASC']],
        });
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
      const initialMemberships = await memberships();
      expect(initialMemberships.tenants.filter((row) => row.userId === actor.id).map((row) => row.tenantId)).toEqual([
        'B',
      ]);
      const saved = await current()
        .resource('users')
        .updateProfile({
          values: nestedHierarchy
            ? { nickname: 'B edited', defaultTenant: { id: 'B', children: [{ id: 'C', parentId: 'B' }] } }
            : invalidDefault
              ? { nickname: 'B edited', defaultTenantId: 'C' }
              : { nickname: 'B edited', tenants: ['B', 'C'] },
        });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toHaveLength(1);
      expect(saved.body.data[0]).toMatchObject({ id: actor.id, nickname: 'B edited' });
      const foreign = await current('C').resource(name).list();
      expect({ foreignStatus: foreign.status, tenants: await tenantRows() }).toEqual({
        foreignStatus: 403,
        tenants: initialTenants,
      });
      expect(foreign.body).not.toHaveProperty('data');
      if (invalidDefault) {
        const headerlessFallback = await agent(login.body.data.token, null).resource(name).list();
        expect(headerlessFallback.status).toBe(200);
        expect(headerlessFallback.body.data).toEqual([originalRows[0]]);
      }
      expect(await memberships()).toEqual(initialMemberships);
      const retained = await current().resource(name).list();
      expect(retained.status).toBe(200);
      expect(retained.body.data).toEqual([originalRows[0]]);
      const relogin = await signIn('profile-tenant-b');
      expect(relogin.status).toBe(200);
      const freshForeign = await agent(relogin.body.data.token, 'C').resource(name).list();
      expect(freshForeign.status).toBe(403);
      expect(freshForeign.body).not.toHaveProperty('data');
      if (invalidDefault) {
        const freshHeaderlessFallback = await agent(relogin.body.data.token, null).resource(name).list();
        expect(freshHeaderlessFallback.status).toBe(200);
        expect(freshHeaderlessFallback.body.data).toEqual([originalRows[0]]);
      }
      const expectedIdentities = initialIdentities.map((row) =>
        row.id === actor.id ? { ...row, nickname: 'B edited', defaultTenantId: invalidDefault ? 'C' : 'B' } : row,
      );
      expect(await identities()).toEqual(expectedIdentities);
      expect(await memberships()).toEqual(initialMemberships);
      expect(await tenantRows()).toEqual(initialTenants);
      expect(await rows()).toEqual(originalRows);
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
