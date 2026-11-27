import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated native tenant switching business writes', () => {
  // Saving only the response tenant, reusing a stale default, or bypassing membership/ACL must fail.
  // 只修改响应租户、沿用旧默认租户或跳过成员/动作权限校验时，本验收必须失败。
  it('uses the switched persisted tenant for subsequent headerless writes and preserves it after a denied switch', async () => {
    let app: MockServer;
    let unregister: (() => void) | undefined;
    let token: string;
    const editor = 'tenant-switch-editor';
    const reader = 'tenant-switch-reader';
    const collectionName = 'tenantSwitchTasks';
    const observed: object[] = [];
    try {
      const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
      app = await createTenantApp({
        aclFactory: createACL,
        database: { dialect: 'sqlite', storage: ':memory:' },
      });
      await app.db.getRepository('tenants').create({
        values: [
          { id: 'B', name: 'B', enabled: true },
          { id: 'C', name: 'C', enabled: true },
          { id: 'D', name: 'D', enabled: true },
        ],
      });
      for (const name of [editor, reader])
        await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
      const password = 'tenant-switch-password';
      const user = await app.db.getRepository('users').create({
        values: { username: editor, password, roles: [editor, reader], tenants: ['B', 'C'], defaultTenantId: 'B' },
      });
      const memberships = async () =>
        (await app.db.getRepository('tenantUsers').find({ filter: { userId: user.id } }))
          .map((item) => ({ userId: item.get('userId'), tenantId: item.get('tenantId') }))
          .sort((a, b) => a.tenantId.localeCompare(b.tenantId));
      expect(await memberships()).toEqual([
        { userId: user.id, tenantId: 'B' },
        { userId: user.id, tenantId: 'C' },
      ]);
      const preferredTenant = async () =>
        (await app.db.getRepository('users').findOne({ filterByTk: user.id })).get('defaultTenantId');
      expect(await preferredTenant()).toBe('B');
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
        expect(
          (await resource.getActions())
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
                  type: 'compare' as const,
                  operator: 'eq' as const,
                  left: { type: 'context' as const, path: 'role.name' },
                  right: { type: 'literal' as const, value: name },
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
            tenantHeader: ctx.get('X-Tenant-ID') || null,
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
      const agent = (roleName = editor) =>
        app
          .agent()
          .set('Authorization', 'Bearer ' + token)
          .set('X-Authenticator', 'basic')
          .set('X-Role', roleName);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data).toMatchObject({ id: user.id, hasPassword: true });
      const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
      expect(await rows()).toEqual([]);
      const first = await agent()
        .resource(collectionName)
        .create({ values: { name: 'B draft' } });
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([{ id: 1, name: 'B draft', tenantId: 'B' }]);

      const switched = await agent()
        .resource('tenants')
        .switch({ values: { tenantId: 'C' } });
      expect(switched.status).toBe(200);
      expect(switched.body.data).toMatchObject({ id: 'C', name: 'C', enabled: true });
      expect(await preferredTenant()).toBe('C');
      expect(await rows()).toEqual([{ id: 1, name: 'B draft', tenantId: 'B' }]);
      const second = await agent()
        .resource(collectionName)
        .create({ values: { name: 'C draft' } });
      expect(second.status).toBe(200);
      expect(second.body.data).toEqual({ keys: [2], affected: 1 });
      const drafts = [
        { id: 1, name: 'B draft', tenantId: 'B' },
        { id: 2, name: 'C draft', tenantId: 'C' },
      ];
      expect(await rows()).toEqual(drafts);
      const listC = await agent().resource(collectionName).list({});
      expect(listC.status).toBe(200);
      expect(listC.body.data).toEqual([{ id: 2, name: 'C draft', tenantId: 'C' }]);
      const otherTenant = await agent()
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Wrong tenant edit' } });
      expect(otherTenant.status).toBe(403);
      expect(await rows()).toEqual(drafts);
      const forbiddenAction = await agent(reader)
        .resource(collectionName)
        .update({ filterByTk: 2, values: { name: 'Missing update permission' } });
      expect(forbiddenAction.status).toBe(403);
      expect(await rows()).toEqual(drafts);
      const forbiddenSwitch = await agent()
        .resource('tenants')
        .switch({ values: { tenantId: 'D' } });
      expect(forbiddenSwitch.status).toBe(403);
      expect(await preferredTenant()).toBe('C');
      expect(await rows()).toEqual(drafts);
      const afterDenied = await agent().resource(collectionName).list({});
      expect(afterDenied.status).toBe(200);
      expect(afterDenied.body.data).toEqual([{ id: 2, name: 'C draft', tenantId: 'C' }]);
      const editedC = await agent()
        .resource(collectionName)
        .update({ filterByTk: 2, values: { name: 'C edit' } });
      expect(editedC.status).toBe(200);
      expect(editedC.body.data).toEqual({ keys: [2], affected: 1 });
      expect(await rows()).toEqual([
        { id: 1, name: 'B draft', tenantId: 'B' },
        { id: 2, name: 'C edit', tenantId: 'C' },
      ]);

      const restored = await agent()
        .resource('tenants')
        .switch({ values: { tenantId: 'B' } });
      expect(restored.status).toBe(200);
      expect(restored.body.data).toMatchObject({ id: 'B', name: 'B', enabled: true });
      expect(await preferredTenant()).toBe('B');
      const listB = await agent().resource(collectionName).list({});
      expect(listB.status).toBe(200);
      expect(listB.body.data).toEqual([{ id: 1, name: 'B draft', tenantId: 'B' }]);
      const editedB = await agent()
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'B edit' } });
      expect(editedB.status).toBe(200);
      expect(editedB.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([
        { id: 1, name: 'B edit', tenantId: 'B' },
        { id: 2, name: 'C edit', tenantId: 'C' },
      ]);
      expect(await memberships()).toEqual([
        { userId: user.id, tenantId: 'B' },
        { userId: user.id, tenantId: 'C' },
      ]);
      expect(observed).toEqual([
        { userId: user.id, role: editor, tenantId: 'C', tenantHeader: null, originalBearer: true },
        { userId: user.id, role: reader, tenantId: 'C', tenantHeader: null, originalBearer: true },
        { userId: user.id, role: editor, tenantId: 'C', tenantHeader: null, originalBearer: true },
        { userId: user.id, role: editor, tenantId: 'B', tenantHeader: null, originalBearer: true },
      ]);
    } finally {
      unregister?.();
      await app?.destroy();
    }
  });
});
