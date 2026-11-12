import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';
import { Gateway } from '@tego/server';

import CustomRequestPlugin from '../../../../../plugin-action-custom-request/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated internal custom-request business updates', () => {
  // Forwarding send credentials must retain the destination action ACL and tenant/G boundary.
  // 转发send凭据必须保留目标动作ACL及租户/G边界。
  it('preserves the original bearer, role and tenant while independently enforcing configured request roles and business updates', async () => {
    let app: MockServer;
    let server: Server;
    let unregister: (() => void) | undefined;
    let token: string;
    const role = 'custom-update-editor';
    const deniedRole = 'custom-update-without-actions';
    const password = 'custom-update-password';
    const collectionName = 'customUpdateTasks';
    const observed: object[] = [];
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
        extraPlugins: [
          [
            CustomRequestPlugin,
            { name: 'custom-request', packageName: '@tachybase/plugin-action-custom-request', workspaceSource: true },
          ],
        ],
      });
      for (const id of ['B', 'C'])
        await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
      for (const name of [role, deniedRole])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const user = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role, deniedRole], tenants: ['B', 'C'], defaultTenantId: 'B' },
      });
      const stored = await app.db.getRepository('collections').create({
        context: {},
        values: {
          name: collectionName,
          tenancy: 'tenantScoped',
          timestamps: false,
          createdBy: false,
          updatedBy: false,
          fields: [{ name: 'name', type: 'string' }],
        },
      });
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields: ['id', 'name', 'tenantId'] },
            { name: 'create', fields: ['name'] },
            { name: 'update', fields: ['name'] },
          ],
        },
      });
      const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
      expect(
        actions
          .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { name: 'create', fields: ['name'] },
        { name: 'list', fields: ['id', 'name', 'tenantId'] },
        { name: 'update', fields: ['name'] },
      ]);
      const source = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
      await app.db.collection(accessConfigHistory).model.sync();
      const registry = new AccessMainRootResourceRegistry(app);
      await registry.store.save(
        source,
        {
          ...configFor({
            type: 'all',
            children: [
              ownerCondition,
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'user.id' },
                right: { type: 'literal', value: String(user.id) },
              },
              {
                type: 'any',
                children: [role, deniedRole].map((name) => ({
                  type: 'compare',
                  operator: 'eq',
                  left: { type: 'context', path: 'role.name' },
                  right: { type: 'literal', value: name },
                })),
              },
            ],
          }),
          revision: 0,
        },
        { userId: user.id },
      );
      const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
      unregister = adapter.register();
      registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => {
        if (ctx.action.resourceName === collectionName && ctx.action.actionName === 'update')
          observed.push({
            userId: ctx.state.currentUser?.id,
            role: ctx.state.currentRole,
            tenantId: ctx.state.currentTenantId,
            originalBearer: ctx.getBearerToken() === token,
          });
        return registry.select(ctx, adapter, [source.collectionKey]);
      });
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: role, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      token = login.body.data.token;
      expect(token).toEqual(expect.any(String));
      const agent = (roleName = role, tenant = 'B') =>
        app
          .agent()
          .set('Authorization', `Bearer ${token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Role', roleName)
          .set('X-Tenant-ID', tenant);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const model = app.db.getCollection(collectionName).model;
      const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      for (const tenant of ['B', 'C']) {
        const created = await agent(role, tenant)
          .resource(collectionName)
          .create({ values: { name: `${tenant} draft` } });
        expect(created.status).toBe(200);
        expect(created.body.data).toEqual({ keys: [tenant === 'B' ? 1 : 2], affected: 1 });
      }
      const before = [
        { id: 1, name: 'B draft', tenantId: 'B' },
        { id: 2, name: 'C draft', tenantId: 'C' },
      ];
      expect(await rows()).toEqual(before);
      for (const [key, roles] of [
        ['editor-only', [role]],
        ['business-acl', [role, deniedRole]],
      ] as const) {
        const request = await app.db.getRepository('customRequests').create({
          values: {
            key,
            roles,
            options: {
              url: `${app.resourcer.options.prefix || ''}/${collectionName}:update`,
              method: 'POST',
              timeout: 5000,
              params: [{ name: 'filterByTk', value: '{{currentRecord.id}}' }],
              data: { name: '{{currentRecord.name}}' },
            },
          },
        });
        const associatedRoles = await app.db.getRepository('customRequests.roles', request.get('key')).find({});
        expect(associatedRoles.map((item) => item.get('name')).sort()).toEqual([...roles].sort());
      }
      server = createServer(app.callback());
      const gateway = Gateway.getInstance();
      expect(gateway.port).toBeGreaterThan(0);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(gateway.port, '127.0.0.1', resolve);
      });
      const address = server.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      expect(gateway.runAtLoop).toBe(`http://127.0.0.1:${address.port}`);
      const send = (key: string, id: number, name: string, roleName = role, tenant = 'B') =>
        agent(roleName, tenant)
          .resource('customRequests')
          .send({
            filterByTk: key,
            values: { currentRecord: { data: { id, name } } },
          });
      const deniedConfig = await send('editor-only', 1, 'Forbidden config edit', deniedRole);
      expect(deniedConfig.status).toBe(403);
      expect(observed).toEqual([]);
      expect(await rows()).toEqual(before);
      const deniedAction = await send('business-acl', 1, 'Forbidden action edit', deniedRole);
      expect(deniedAction.status).toBe(403);
      expect(await rows()).toEqual(before);
      const deniedTenant = await send('editor-only', 2, 'Forbidden cross-tenant edit');
      expect(deniedTenant.status).toBe(403);
      expect(await rows()).toEqual(before);
      const updatedB = await send('editor-only', 1, 'B edit');
      expect(updatedB.status).toBe(200);
      expect(updatedB.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([{ id: 1, name: 'B edit', tenantId: 'B' }, before[1]]);
      const updatedC = await send('editor-only', 2, 'C edit', role, 'C');
      expect(updatedC.status).toBe(200);
      expect(updatedC.body.data).toEqual({ keys: [2], affected: 1 });
      const final = [
        { id: 1, name: 'B edit', tenantId: 'B' },
        { id: 2, name: 'C edit', tenantId: 'C' },
      ];
      expect(await rows()).toEqual(final);
      for (const [index, tenant] of ['B', 'C'].entries()) {
        const list = await agent(role, tenant).resource(collectionName).list({});
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual([final[index]]);
      }
      expect(observed).toEqual([
        { userId: user.id, role: deniedRole, tenantId: 'B', originalBearer: true },
        { userId: user.id, role, tenantId: 'B', originalBearer: true },
        { userId: user.id, role, tenantId: 'B', originalBearer: true },
        { userId: user.id, role, tenantId: 'C', originalBearer: true },
      ]);
    } finally {
      if (server?.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      unregister?.();
      await app?.destroy();
    }
  });
});
