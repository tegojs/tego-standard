import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { require as tsxRequire } from 'tsx/cjs/api';

import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated native own scope business lifecycle', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // A stranded own marker breaks normal use; losing its filter lets one user edit another's task.
  // 未消费 own 标志会阻断正常业务；丢失创建人条件会错误允许修改另一用户的任务。
  it('retains native creator restrictions and tenant G during own reads, edits and deletion', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    for (const id of ['B', 'C']) {
      await app.db.getRepository('tenants').create({ values: { id, name: id, enabled: true } });
    }
    const role = 'own-task-editor';
    const password = 'own-task-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const accounts = ['own-task-alice', 'own-task-bob'];
    const userIds: number[] = [];
    for (const username of accounts) {
      const user = await app.db.getRepository('users').create({
        values: { username, password, roles: [role], tenants: ['B', 'C'], defaultTenantId: 'B' },
      });
      userIds.push(user.get('id') as number);
    }
    const [aliceId, bobId] = userIds;
    expect(aliceId).toEqual(expect.any(Number));
    expect(bobId).toEqual(expect.any(Number));
    expect(aliceId).not.toBe(bobId);
    const collectionName = 'ownBusinessTasks';
    const stored = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        timestamps: false,
        createdBy: true,
        updatedBy: true,
        fields: [{ name: 'name', type: 'string' }],
      },
    });
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').findOne({
      filter: { dataSourceKey: 'main', key: 'own' },
    });
    expect(scope).toBeTruthy();
    expect(scope.get('scope')).toEqual({ createdById: '{{ ctx.state.currentUser.id }}' });
    const fields = ['id', 'name', 'tenantId', 'createdById', 'updatedById'];
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'create', fields: ['name'] },
          { name: 'list', fields, scope: { id: scope.get('id') } },
          { name: 'update', fields: ['name'], scope: { id: scope.get('id') } },
          { name: 'destroy', fields: ['id'], scope: { id: scope.get('id') } },
        ],
      },
    });
    const actions = await resource.getActions({ include: ['scope'] });
    expect(
      actions
        .map((action) => ({
          name: action.get('name'),
          fields: [...action.get('fields')].sort(),
          scopeId: action.get('scope')?.get('id') ?? null,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      { name: 'create', fields: ['name'], scopeId: null },
      { name: 'destroy', fields: ['id'], scopeId: scope.get('id') },
      { name: 'list', fields: ['createdById', 'id', 'name', 'tenantId', 'updatedById'], scopeId: scope.get('id') },
      { name: 'update', fields: ['name'], scopeId: scope.get('id') },
    ]);
    const identity = { dataSourceKey: 'main', collectionKey: stored.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    const config = configFor(ownerCondition);
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        rules: userIds.map((userId) => ({
          ...config.rules[0],
          id: `own-user-${userId}`,
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
                right: { type: 'literal', value: role },
              },
            ],
          },
        })),
      },
      { userId: aliceId },
    );
    // Use the native workspace plugin loader so persisted provenance shares the adapter's module instance.
    // 使用原生工作区插件加载器，使持久权限来源与适配器共享模块实例。
    const { AccessAclScopeAdapter } = tsxRequire(
      '../../access-control/acl-scope.ts',
      import.meta.url,
    ) as typeof import('../../access-control/acl-scope');
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    let selected = false;
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, selected ? [identity.collectionKey] : []),
    );
    const tokens: string[] = [];
    for (const [index, account] of accounts.entries()) {
      const signedIn = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account, password });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.user.id).toBe(userIds[index]);
      expect(signedIn.body.data.user.hasPassword).toBe(true);
      expect(signedIn.body.data.token).toEqual(expect.any(String));
      tokens.push(signedIn.body.data.token);
    }
    const agent = (index: number, tenant = 'B') =>
      app
        .agent()
        .set('Authorization', `Bearer ${tokens[index]}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', tenant);
    for (const index of [0, 1]) {
      const checked = await agent(index).get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(userIds[index]);
    }
    const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    selected = true;
    for (const [index, tenant, name, key] of [
      [0, 'B', 'Alice task', 1],
      [1, 'B', 'Bob task', 2],
      [0, 'C', 'Alice C task', 3],
    ] as const) {
      const created = await agent(index, tenant).resource(collectionName).create({ values: { name } });
      expect(created.status).toBe(200);
      expect(created.body.data).toEqual({ keys: [key], affected: 1 });
    }
    const original = [
      { id: 1, name: 'Alice task', tenantId: 'B', createdById: aliceId, updatedById: aliceId },
      { id: 2, name: 'Bob task', tenantId: 'B', createdById: bobId, updatedById: bobId },
      { id: 3, name: 'Alice C task', tenantId: 'C', createdById: aliceId, updatedById: aliceId },
    ];
    expect(await rows()).toEqual(original);
    selected = false;
    const baseline = await agent(0)
      .resource(collectionName)
      .list({ fields, sort: ['id'] });
    expect(baseline.status).toBe(200);
    expect(baseline.body.data).toEqual([original[0]]);
    selected = true;
    for (const [index, tenant, row] of [
      [0, 'B', 0],
      [1, 'B', 1],
      [0, 'C', 2],
    ] as const) {
      const listed = await agent(index, tenant)
        .resource(collectionName)
        .list({ fields, sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([original[row]]);
    }
    // All targets were just created here and read by their creator; no unknown business data is addressed.
    // 所有目标均在本项刚创建并由创建者正常读取，不访问未知业务数据。
    for (const key of [2, 3]) {
      const denied = await agent(0)
        .resource(collectionName)
        .update({ filterByTk: key, values: { name: 'Denied edit' } });
      expect(denied.status).toBe(403);
      expect(await rows()).toEqual(original);
      const deniedDestroy = await agent(0).resource(collectionName).destroy({ filterByTk: key });
      expect(deniedDestroy.status).toBe(403);
      expect(await rows()).toEqual(original);
    }
    const edited = await agent(0)
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Alice edited task' } });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toEqual({ keys: [1], affected: 1 });
    const changed = [{ ...original[0], name: 'Alice edited task' }, original[1], original[2]];
    expect(await rows()).toEqual(changed);
    const bobEdited = await agent(1)
      .resource(collectionName)
      .update({ filterByTk: 2, values: { name: 'Bob edited task' } });
    expect(bobEdited.status).toBe(200);
    expect(bobEdited.body.data).toEqual({ keys: [2], affected: 1 });
    const final = [changed[0], { ...original[1], name: 'Bob edited task' }, original[2]];
    expect(await rows()).toEqual(final);
    const destroyed = await agent(0).resource(collectionName).destroy({ filterByTk: 1 });
    expect(destroyed.status).toBe(200);
    expect(destroyed.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([final[1], final[2]]);
    const empty = await agent(0).resource(collectionName).list({ fields });
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);
  });
});
