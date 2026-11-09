import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated current-user role scopes', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Reusing another request's resolved ACL filter must break these real reads and writes.
  // 复用另一请求已解析的 ACL 条件必须使这里的真实读写断言失败。
  it('resolves a shared role scope for each authenticated user during ordinary task edits', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const role = 'assigned-task-editor';
    const password = 'assigned-task-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const accounts = ['assigned-task-alice', 'assigned-task-bob'];
    const userIds: number[] = [];
    for (const username of accounts) {
      const user = await app.db.getRepository('users').create({
        values: { username, password, roles: [role], tenants: ['B'], defaultTenantId: 'B' },
      });
      userIds.push(user.get('id') as number);
    }
    const [aliceId, bobId] = userIds;
    expect(aliceId).toEqual(expect.any(Number));
    expect(bobId).toEqual(expect.any(Number));
    expect(aliceId).not.toBe(bobId);
    const collectionName = 'assignedTasks';
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
          { name: 'assigneeId', type: 'integer' },
        ],
      },
    });
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Current user tasks',
        resourceName: collectionName,
        scope: { assigneeId: { $eq: '{{ ctx.state.currentUser.id }}' } },
      },
    });
    const fields = ['id', 'name', 'assigneeId', 'tenantId'];
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields, scope: { id: scope.get('id') } },
          { name: 'create', fields: ['name', 'assigneeId'], scope: { id: scope.get('id') } },
          { name: 'update', fields: ['name'], scope: { id: scope.get('id') } },
        ],
      },
    });
    const actions = await resource.getActions({ include: ['scope'] });
    expect(
      actions
        .map((action) => ({
          name: action.get('name'),
          fields: [...action.get('fields')].sort(),
          filter: action.get('scope')?.get('scope'),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      {
        name: 'create',
        fields: ['assigneeId', 'name'],
        filter: { assigneeId: { $eq: '{{ ctx.state.currentUser.id }}' } },
      },
      {
        name: 'list',
        fields: ['assigneeId', 'id', 'name', 'tenantId'],
        filter: { assigneeId: { $eq: '{{ ctx.state.currentUser.id }}' } },
      },
      {
        name: 'update',
        fields: ['name'],
        filter: { assigneeId: { $eq: '{{ ctx.state.currentUser.id }}' } },
      },
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
          id: `assigned-user-${userId}`,
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
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) =>
      registry.select(ctx, adapter, [identity.collectionKey]),
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
    const agent = (index: number) =>
      app
        .agent()
        .set('Authorization', `Bearer ${tokens[index]}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', 'B');
    for (const index of [0, 1]) {
      const checked = await agent(index).get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(userIds[index]);
    }
    const rows = () => app.db.getCollection(collectionName).model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const aliceCreated = await agent(0)
      .resource(collectionName)
      .create({ values: { name: 'Alice task', assigneeId: aliceId } });
    expect(aliceCreated.status).toBe(200);
    expect(aliceCreated.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Alice task', assigneeId: aliceId, tenantId: 'B' }]);
    const bobCreated = await agent(1)
      .resource(collectionName)
      .create({ values: { name: 'Bob task', assigneeId: bobId } });
    expect(bobCreated.status).toBe(200);
    expect(bobCreated.body.data).toEqual({ keys: [2], affected: 1 });
    const original = [
      { id: 1, name: 'Alice task', assigneeId: aliceId, tenantId: 'B' },
      { id: 2, name: 'Bob task', assigneeId: bobId, tenantId: 'B' },
    ];
    expect(await rows()).toEqual(original);
    for (const index of [0, 1, 0]) {
      const listed = await agent(index)
        .resource(collectionName)
        .list({ fields, sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([original[index]]);
    }
    // Both targets were just created by these fixture users; no unknown or sensitive row is addressed.
    // 两个目标均由本夹具用户刚刚创建，不访问未知或敏感记录。
    const denied = await agent(1)
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Other task edit' } });
    expect(denied.status).toBe(403);
    expect(await rows()).toEqual(original);
    const aliceEdited = await agent(0)
      .resource(collectionName)
      .update({ filterByTk: 1, values: { name: 'Alice edited task' } });
    expect(aliceEdited.status).toBe(200);
    expect(aliceEdited.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([
      { id: 1, name: 'Alice edited task', assigneeId: aliceId, tenantId: 'B' },
      { id: 2, name: 'Bob task', assigneeId: bobId, tenantId: 'B' },
    ]);
    const bobEdited = await agent(1)
      .resource(collectionName)
      .update({ filterByTk: 2, values: { name: 'Bob edited task' } });
    expect(bobEdited.status).toBe(200);
    expect(bobEdited.body.data).toEqual({ keys: [2], affected: 1 });
    const final = [
      { id: 1, name: 'Alice edited task', assigneeId: aliceId, tenantId: 'B' },
      { id: 2, name: 'Bob edited task', assigneeId: bobId, tenantId: 'B' },
    ];
    expect(await rows()).toEqual(final);
    for (const index of [1, 0]) {
      const listed = await agent(index)
        .resource(collectionName)
        .list({ fields, sort: ['id'] });
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([final[index]]);
    }
  });
});
