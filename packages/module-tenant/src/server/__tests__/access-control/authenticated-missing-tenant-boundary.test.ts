import { pathToFileURL } from 'node:url';
import type { MockServer } from '@tachybase/test';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { registerAuthenticatedAccessRootRuntime } from '../../access-control/authenticated-root-runtime';
import { accessConfigHistory } from '../../access-control/config-history';
import { AccessMainRootResourceRegistry } from '../../access-control/main-root-resource-registry';
import { createTenantApp } from '../utils';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;

describe.skipIf(!coreEntry)('authenticated missing tenant business boundary', () => {
  let app: MockServer;
  let unregister: (() => void) | undefined;

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  // A missing tenant must be an actionable denial before business SQL, not an empty success or server error.
  // 缺少租户必须在业务 SQL 前明确拒绝，不能伪装为空结果成功或服务端故障。
  it.each(['list', 'create'] as const)('rejects %s without a tenant while preserving member access', async (action) => {
    const { createACL } = await import(/* @vite-ignore */ pathToFileURL(coreEntry!).href);
    app = await createTenantApp({ aclFactory: createACL, database: { dialect: 'sqlite', storage: ':memory:' } });
    await app.db.getRepository('tenants').create({ values: { id: 'B', name: 'B', enabled: true } });
    const role = 'missing-tenant-editor';
    const password = 'missing-tenant-test-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const users = [];
    for (const member of [false, true]) {
      users.push(
        await app.db.getRepository('users').create({
          values: {
            username: member ? 'tenant-member' : 'without-tenant',
            password,
            roles: [role],
            tenants: member ? ['B'] : [],
            defaultTenantId: member ? 'B' : null,
          },
        }),
      );
    }
    const userId = users[0].get('id');
    expect(await app.db.getRepository('tenantUsers').count({ filter: { userId } })).toBe(0);
    expect((await app.db.getRepository('users').findOne({ filterByTk: userId })).get('defaultTenantId')).toBeNull();
    const collectionName = 'missingTenantTasks';
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
    const model = app.db.getCollection(collectionName).model;
    const table = model.getTableName();
    const quotedTable = '`' + (typeof table === 'string' ? table : table.tableName) + '`';
    const rows = () => model.findAll({ raw: true, order: [['id', 'ASC']] });
    expect(await rows()).toEqual([]);
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: collectionName,
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['id', 'name', 'tenantId'] },
          { name: 'create', fields: ['name'] },
        ],
      },
    });
    const actions = await app.db.getRepository('dataSourcesRolesResources.actions', resource.get('id')).find({});
    expect(
      actions
        .map((item) => ({ name: item.get('name'), fields: item.get('fields') }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual([
      { name: 'create', fields: ['name'] },
      { name: 'list', fields: ['id', 'name', 'tenantId'] },
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
        rules: config.rules.map((rule) => ({
          ...rule,
          subject: {
            type: 'all',
            children: [
              {
                type: 'compare',
                operator: 'eq',
                left: { type: 'context', path: 'role.name' },
                right: { type: 'literal', value: role },
              },
              {
                type: 'any',
                children: users.map((user) => ({
                  type: 'compare',
                  operator: 'eq',
                  left: { type: 'context', path: 'user.id' },
                  right: { type: 'literal', value: String(user.get('id')) },
                })),
              },
            ],
          },
        })),
      },
      { userId },
    );
    const adapter = new AccessAclScopeAdapter(app.acl, 'main', registry.store, app.db);
    unregister = adapter.register();
    const observed: Array<{ userId: number; tenantId: unknown; tenant: unknown }> = [];
    registerAuthenticatedAccessRootRuntime(app.resourcer, (ctx) => {
      if (ctx.action.resourceName === collectionName)
        observed.push({
          userId: ctx.state.currentUser?.id,
          tenantId: ctx.state.currentTenantId,
          tenant: ctx.state.currentTenant,
        });
      return registry.select(ctx, adapter, [identity.collectionKey]);
    });
    const agents = [];
    for (const user of users) {
      const signedIn = await app
        .agent()
        .post('/auth:signIn')
        .set('X-Authenticator', 'basic')
        .send({ account: user.get('username'), password });
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.user.id).toBe(user.get('id'));
      expect(signedIn.body.data.user.hasPassword).toBe(true);
      const token = signedIn.body.data.token;
      expect(token).toEqual(expect.any(String));
      const agent = () =>
        app.agent().set('Authorization', `Bearer ${token}`).set('X-Authenticator', 'basic').set('X-Role', role);
      const checked = await agent().get('/auth:check');
      expect(checked.status).toBe(200);
      expect(checked.body.data.id).toBe(user.get('id'));
      agents.push(agent);
    }
    const sql: string[] = [];
    const logging = app.db.sequelize.options.logging;
    app.db.sequelize.options.logging = (statement) => sql.push(statement);
    try {
      const denied =
        action === 'list'
          ? await agents[0]()
              .resource(collectionName)
              .list({ fields: ['id', 'name', 'tenantId'] })
          : await agents[0]()
              .resource(collectionName)
              .create({ values: { name: 'Needs tenant' } });
      expect(sql.filter((statement) => statement.includes(quotedTable))).toEqual([]);
      expect(denied.status).toBe(403);
      expect(denied.body.errors[0].message).toBe(
        'No tenant is selected. Select a tenant and try again. If no tenant is available, contact an administrator.',
      );
      expect(denied.body.data).toBeUndefined();
    } finally {
      app.db.sequelize.options.logging = logging;
    }
    expect(await rows()).toEqual([]);
    expect(observed).toEqual([{ userId, tenantId: undefined, tenant: undefined }]);

    // The same granted role can read and create with a real persisted default tenant.
    // 同一真实授权角色在具备持久默认租户时仍能正常读取和新增。
    const listed = await agents[1]()
      .resource(collectionName)
      .list({ fields: ['id', 'name', 'tenantId'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);
    const created = await agents[1]()
      .resource(collectionName)
      .create({ values: { name: 'Member draft' } });
    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({ keys: [1], affected: 1 });
    expect(await rows()).toEqual([{ id: 1, name: 'Member draft', tenantId: 'B' }]);
    expect(observed.slice(1).map((state) => ({ userId: state.userId, tenantId: state.tenantId }))).toEqual([
      { userId: users[1].get('id'), tenantId: 'B' },
      { userId: users[1].get('id'), tenantId: 'B' },
    ]);
    expect(await app.db.getRepository('tenantUsers').count({ filter: { userId } })).toBe(0);
    expect((await app.db.getRepository('users').findOne({ filterByTk: userId })).get('defaultTenantId')).toBeNull();
  });
});
