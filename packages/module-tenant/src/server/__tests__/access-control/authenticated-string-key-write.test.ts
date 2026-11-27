import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated string business primary keys', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // Hard-coding id or coercing textual keys to integers must break authorization and the stored results.
  // 写死 id 或将文本业务键转换为整数时，授权定位和完整持久结果必须不再通过。
  it('keeps 001 and 1 distinct across authenticated creation, reads and mutations', async () => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({
      values: [
        { id: 'B', name: 'B', enabled: true },
        { id: 'C', name: 'C', enabled: true },
      ],
    });
    const role = 'business-key-editor';
    const password = 'business-key-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const user = await app.db.getRepository('users').create({
      values: { username: role, password, roles: [role], tenants: ['B', 'C'], defaultTenantId: 'B' },
    });
    const userId = user.get('id');
    const collectionName = 'keyedBusinessTasks';
    const collection = await app.db.getRepository('collections').create({
      context: {},
      values: {
        name: collectionName,
        tenancy: 'tenantScoped',
        autoGenId: false,
        filterTargetKey: 'taskKey',
        timestamps: false,
        createdBy: false,
        updatedBy: false,
        fields: [
          { name: 'taskKey', type: 'string', primaryKey: true, allowNull: false },
          { name: 'name', type: 'string' },
        ],
      },
    });
    const runtime = app.db.getCollection(collectionName);
    expect(runtime.model.primaryKeyAttributes).toEqual(['taskKey']);
    expect(runtime.filterTargetKey).toBe('taskKey');
    expect(runtime.model.rawAttributes).not.toHaveProperty('id');
    const columns = await app.db.sequelize.getQueryInterface().describeTable(runtime.getTableNameWithSchema());
    expect(columns.taskKey.primaryKey).toBe(true);
    expect(columns).not.toHaveProperty('id');
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['taskKey', 'name', 'tenantId'] },
          { name: 'get', fields: ['taskKey', 'name', 'tenantId'] },
          { name: 'create', fields: ['taskKey', 'name'] },
          { name: 'update', fields: ['name'] },
          { name: 'destroy' },
        ],
      },
    });
    const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
    expect(
      actions
        .map((action) => ({ name: action.get('name'), fields: [...action.get('fields')].sort() }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      { name: 'create', fields: ['name', 'taskKey'] },
      { name: 'destroy', fields: [] },
      { name: 'get', fields: ['name', 'taskKey', 'tenantId'] },
      { name: 'list', fields: ['name', 'taskKey', 'tenantId'] },
      { name: 'update', fields: ['name'] },
    ]);
    const identity = { dataSourceKey: 'main', collectionKey: collection.get('key'), collectionName };
    await app.db.collection(accessConfigHistory).model.sync();
    const registry = new AccessMainRootResourceRegistry(app);
    const config = configFor(ownerCondition);
    await registry.store.save(
      identity,
      {
        ...config,
        revision: 0,
        rules: config.rules.map((rule) => ({
          ...rule,
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
      .send({ account: role, password });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user).toMatchObject({ id: userId, hasPassword: true });
    const token = signedIn.body.data.token;
    expect(token).toEqual(expect.any(String));
    const agent = (tenantId: 'B' | 'C' = 'B') =>
      app
        .agent()
        .set('Authorization', `Bearer ${token}`)
        .set('X-Authenticator', 'basic')
        .set('X-Role', role)
        .set('X-Tenant-Id', tenantId);
    const checked = await agent().get('/auth:check');
    expect(checked.status).toBe(200);
    expect(checked.body.data).toMatchObject({ id: userId, hasPassword: true });
    const rows = () => runtime.model.findAll({ raw: true, order: [['taskKey', 'ASC']] });
    expect(await rows()).toEqual([]);
    const first = await agent()
      .resource(collectionName)
      .create({ values: { taskKey: '001', name: 'First task' } });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ keys: ['001'], affected: 1 });
    const second = await agent('C')
      .resource(collectionName)
      .create({ values: { taskKey: '1', name: 'Other tenant task' } });
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ keys: ['1'], affected: 1 });
    const before = [
      { taskKey: '001', name: 'First task', tenantId: 'B' },
      { taskKey: '1', name: 'Other tenant task', tenantId: 'C' },
    ];
    expect(await rows()).toEqual(before);
    const ownList = await agent()
      .resource(collectionName)
      .list({ fields: ['taskKey', 'name', 'tenantId'], sort: ['taskKey'] });
    expect(ownList.status).toBe(200);
    expect(ownList.body.data).toEqual([{ taskKey: '001', name: 'First task', tenantId: 'B' }]);
    const own = await agent()
      .resource(collectionName)
      .get({ filterByTk: '001', fields: ['taskKey', 'name', 'tenantId'] });
    expect(own.status).toBe(200);
    expect(own.body.data).toEqual({ taskKey: '001', name: 'First task', tenantId: 'B' });
    const other = await agent('C')
      .resource(collectionName)
      .get({ filterByTk: '1', fields: ['taskKey', 'name', 'tenantId'] });
    expect(other.status).toBe(200);
    expect(other.body.data).toEqual({ taskKey: '1', name: 'Other tenant task', tenantId: 'C' });
    const denied = await agent()
      .resource(collectionName)
      .update({ filterByTk: '1', values: { name: 'Must not change either task' } });
    expect(denied.status).toBe(403);
    expect(await rows()).toEqual(before);
    const updated = await agent()
      .resource(collectionName)
      .update({ filterByTk: '001', values: { name: 'Edited task' } });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({ keys: ['001'], affected: 1 });
    expect(await rows()).toEqual([
      { taskKey: '001', name: 'Edited task', tenantId: 'B' },
      { taskKey: '1', name: 'Other tenant task', tenantId: 'C' },
    ]);
    const destroyed = await agent().resource(collectionName).destroy({ filterByTk: '001' });
    expect(destroyed.status).toBe(200);
    expect(destroyed.body.data).toEqual({ keys: ['001'], affected: 1 });
    expect(await rows()).toEqual([{ taskKey: '1', name: 'Other tenant task', tenantId: 'C' }]);
    const finalList = await agent()
      .resource(collectionName)
      .list({ fields: ['taskKey', 'name', 'tenantId'] });
    expect(finalList.status).toBe(200);
    expect(finalList.body.data).toEqual([]);
  });
});
