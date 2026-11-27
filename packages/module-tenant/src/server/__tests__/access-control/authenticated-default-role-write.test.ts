import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated default role business updates', () => {
  // A persisted role preference must affect the next headerless request without broadening its ACL.
  // 持久默认角色必须作用于下一次无角色头请求，且不能扩大该角色的动作权限。
  it('uses the saved default after native preference changes and keeps explicit overrides local to one request', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let token: string;
    const editor = 'default-role-editor';
    const reader = 'default-role-reader';
    const collectionName = 'defaultRoleTasks';
    const observed: object[] = [];
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
      });
      await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
      for (const name of [reader, editor])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'default-role-password';
      const user = await app.db.getRepository('users').create({
        values: { username: editor, password, roles: [reader, editor], tenants: ['B'], defaultTenantId: 'B' },
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
      for (const roleName of [editor, reader]) {
        const expected = [
          { name: 'list', fields: ['id', 'name', 'tenantId'] },
          ...(roleName === editor
            ? [
                { name: 'create', fields: ['name'] },
                { name: 'update', fields: ['name'] },
              ]
            : []),
        ].sort((a, b) => a.name.localeCompare(b.name));
        const resource = await app.db.getRepository('dataSourcesRolesResources').create({
          values: {
            dataSourceKey: 'main',
            roleName,
            name: collectionName,
            usingActionsConfig: true,
            actions: expected,
          },
        });
        const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
        expect(
          actions
            .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ).toEqual(expected);
      }
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
                children: [editor, reader].map((name) => ({
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
            roleHeader: ctx.get('X-Role') || null,
            tenantId: ctx.state.currentTenantId,
            originalBearer: ctx.getBearerToken() === token,
          });
        return registry.select(ctx, adapter, [source.collectionKey]);
      });
      const login = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: editor, password });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: user.id, hasPassword: true });
      token = login.body.data.token;
      expect(token).toEqual(expect.any(String));
      const agent = (roleName?: string) => {
        const request = app
          .agent()
          .set('Authorization', `Bearer ${token}`)
          .set('X-Authenticator', 'basic')
          .set('X-Tenant-ID', 'B');
        return roleName ? request.set('X-Role', roleName) : request;
      };
      const memberships = async () =>
        (await app.db.getRepository('rolesUsers').find({ filter: { userId: user.id } }))
          .map((item) => ({ userId: item.get('userId'), roleName: item.get('roleName'), default: item.get('default') }))
          .sort((a, b) => a.roleName.localeCompare(b.roleName));
      const defaults = (roleName: string) => [
        { userId: user.id, roleName: editor, default: roleName === editor },
        { userId: user.id, roleName: reader, default: roleName === reader },
      ];
      const prefer = async (roleName: string, explicitRole?: string) => {
        const response = await agent(explicitRole).post('/users:setDefaultRole').send({ roleName });
        expect(response.status).toBe(200);
        expect(await memberships()).toEqual(defaults(roleName));
      };
      await prefer(editor, editor);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.id);
      const model = app.db.getCollection(collectionName).model;
      const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const created = await agent()
        .resource(collectionName)
        .create({ values: { name: 'Draft task' } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([{ id: 1, name: 'Draft task', tenantId: 'B' }]);
      const update = (name: string, roleName?: string) =>
        agent(roleName).resource(collectionName).update({ filterByTk: 1, values: { name } });
      const first = await update('First edit');
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual({ keys: [1], affected: 1 });
      const firstRows = [{ id: 1, name: 'First edit', tenantId: 'B' }];
      expect(await rows()).toEqual(firstRows);

      await prefer(reader);
      const denied = await update('Forbidden default edit');
      expect(denied.status).toBe(403);
      expect(await rows()).toEqual(firstRows);
      const readerList = await agent().resource(collectionName).list({});
      expect(readerList.status).toBe(200);
      expect(readerList.body.data).toEqual(firstRows);
      const explicit = await update('Explicit edit', editor);
      expect(explicit.status).toBe(200);
      expect(explicit.body.data).toEqual({ keys: [1], affected: 1 });
      const explicitRows = [{ id: 1, name: 'Explicit edit', tenantId: 'B' }];
      expect(await rows()).toEqual(explicitRows);
      expect(await memberships()).toEqual(defaults(reader));
      const deniedAgain = await update('Forbidden leaked-role edit');
      expect(deniedAgain.status).toBe(403);
      expect(await rows()).toEqual(explicitRows);

      await prefer(editor);
      const restored = await update('Default edit');
      expect(restored.status).toBe(200);
      expect(restored.body.data).toEqual({ keys: [1], affected: 1 });
      const final = [{ id: 1, name: 'Default edit', tenantId: 'B' }];
      expect(await rows()).toEqual(final);
      const finalList = await agent().resource(collectionName).list({});
      expect(finalList.status).toBe(200);
      expect(finalList.body.data).toEqual(final);
      expect(await memberships()).toEqual(defaults(editor));
      expect(observed).toEqual([
        { userId: user.id, role: editor, roleHeader: null, tenantId: 'B', originalBearer: true },
        { userId: user.id, role: reader, roleHeader: null, tenantId: 'B', originalBearer: true },
        { userId: user.id, role: editor, roleHeader: editor, tenantId: 'B', originalBearer: true },
        { userId: user.id, role: reader, roleHeader: null, tenantId: 'B', originalBearer: true },
        { userId: user.id, role: editor, roleHeader: null, tenantId: 'B', originalBearer: true },
      ]);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
