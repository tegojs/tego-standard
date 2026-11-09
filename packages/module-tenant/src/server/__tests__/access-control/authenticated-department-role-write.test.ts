import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../../../../../plugin-department/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated department role business writes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Ignoring attached membership loses legitimate writes; unioning roles leaks actions or fields.
  // 忽略部门成员角色会拒绝正常写入，合并角色权限则会泄漏动作或字段权限。
  it.each(['actions', 'fields'] as const)('uses only the selected role for %s', async (boundary) => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({
      aclFactory: createACL,
      database: { dialect: 'sqlite', storage: ':memory:' },
      extraPlugins: [
        [
          PluginDepartmentServer,
          { name: 'department', packageName: '@tachybase/plugin-department', workspaceSource: true },
        ],
      ],
    });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const directRole = 'department-direct';
    const attachedRole = 'department-attached';
    for (const name of [directRole, attachedRole])
      await app.db.getRepository('roles').create({ values: { name, strategy: { actions: [] }, snippets: [] } });
    const password = 'department-role-test-password';
    const user = await app.db.getRepository('users').create({
      values: { username: 'department-writer', password, roles: [directRole], tenants: ['B'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const department = await app.db.getRepository('departments').create({
      values: { title: 'Fixture department', members: [userId], roles: [attachedRole] },
    });
    const directRoles = await app.db.getRepository('users.roles', userId).find({});
    expect(directRoles.map((role) => role.get('name'))).toEqual([directRole]);
    const departments = await app.db.getRepository('users.departments', userId).find({});
    expect(departments.map((entry) => entry.get('id'))).toEqual([department.get('id')]);
    const departmentRoles = await app.db.getRepository('departments.roles', department.get('id')).find({});
    expect(departmentRoles.map((role) => role.get('name'))).toEqual([attachedRole]);

    const collectionName = 'departmentRoleTasks';
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
        ],
      },
    });
    for (const roleName of [directRole, attachedRole]) {
      const writeActions = roleName === directRole && boundary === 'actions' ? [] : ['create', 'update'];
      const writeFields = roleName === attachedRole && boundary === 'fields' ? ['name'] : ['name', 'amount'];
      const resource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName,
          name: collectionName,
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields: ['id', 'name', 'amount', 'tenantId'] },
            ...writeActions.map((name) => ({ name, fields: writeFields })),
          ],
        },
      });
      const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
      expect(actions.map((action) => action.get('name')).sort()).toEqual([...writeActions, 'list'].sort());
      for (const action of actions)
        expect([...action.get('fields')].sort()).toEqual(
          action.get('name') === 'list' ? ['amount', 'id', 'name', 'tenantId'] : [...writeFields].sort(),
        );
    }
    const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    const config = configFor(ownerCondition);
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        rules: [directRole, attachedRole].map((roleName) => ({
          ...config.rules[0],
          id: roleName,
          subject: {
            type: 'all',
            children: [
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'user.id' },
                right: { type: 'literal', value: String(userId) },
              },
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'role.name' },
                right: { type: 'literal', value: roleName },
              },
            ],
          },
        })),
      },
      { userId },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, [identity.collectionKey]),
    );
    const signedIn = await app
      .agent()
      .post('/auth:signIn')
      .set('X-Authenticator', 'basic')
      .send({ account: 'department-writer', password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.id).toBe(userId);
    expect(signedIn.body.data.user.hasPassword).toBe(true);
    expect(signedIn.body.data.token).toEqual(expect.any(String));
    const agent = (roleName: string) =>
      app
        .agent()
        .set('Authorization', `Bearer ${signedIn.body.data.token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', roleName)
        .set('X-Tenant-Id', 'B');
    for (const roleName of [directRole, attachedRole]) {
      const checked = await agent(roleName).get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(userId);
    }
    const tasks = app.db.getCollection(collectionName);
    const rows = () => tasks.model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const created = await agent(attachedRole)
      .resource(collectionName)
      .create({ values: { name: 'Department task', amount: 10 } });
    expect(created.status).toBe(200);
    expect(await rows()).toEqual([
      { id: 1, name: 'Department task', amount: boundary === 'actions' ? 10 : null, tenantId: 'B' },
    ]);
    const edited = await agent(attachedRole)
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Department edit', amount: 20 } });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'Department edit', amount: boundary === 'actions' ? 20 : null, tenantId: 'B' },
    ]);
    const visible = await agent(attachedRole)
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'amount', 'tenantId'], sort: ['id'] });
    expect(visible.status).toBe(200);
    expect(visible.body.data).toEqual([
      { id: 1, name: 'Department edit', amount: boundary === 'actions' ? 20 : null, tenantId: 'B' },
    ]);
    if (boundary === 'actions') {
      const denied = await agent(directRole)
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Direct edit', amount: 30 } });
      expect(denied.status).toBe(403);
      expect(await rows()).toEqual([{ id: 1, name: 'Department edit', amount: 20, tenantId: 'B' }]);
    } else {
      const full = await agent(directRole)
        .resource(collectionName)
        .update({ filterByTk: 1, values: { name: 'Direct edit', amount: 30 } });
      expect(full.status).toBe(200);
      expect(full.body.data).toEqual({ keys: [1], affected: 1 });
      expect(await rows()).toEqual([{ id: 1, name: 'Direct edit', amount: 30, tenantId: 'B' }]);
    }
    // The same token and unchanged memberships still select the attached role, not a permission union.
    // 同一令牌及不变成员关系仍只选择部门角色，不合并其他角色权限。
    const final = await agent(attachedRole)
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Final department edit', amount: 40 } });
    expect(final.status).toBe(200);
    expect(final.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'Final department edit', amount: boundary === 'actions' ? 40 : 30, tenantId: 'B' },
    ]);
  });
});
