import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated user department association scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each(['add', 'remove'] as const)('enforces the persisted source-user scope for association %s', async (action) => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: [
        'acl',
        'auth',
        'users',
        'data-source-manager',
        'error-handler',
        [
          PluginDepartmentServer,
          { name: 'department', packageName: '@tachybase/plugin-department', workspaceSource: true },
        ],
      ],
    });
    const role = 'user-department-association-operator';
    const password = 'user-department-association-password';
    await app.db
      .getRepository('roles')
      .create({ values: { name: role, strategy: { actions: [] }, snippets: ['pm.department'] } });
    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: 'user-department-association-operator', password, roles: [role] },
    });
    const target = await users.create({
      values: { username: 'user-department-association-target', roles: ['member'] },
    });
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Only operator user',
        resourceName: 'users.departments',
        scope: { id: { $eq: operator.id } },
      },
    });
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'users.departments',
        usingActionsConfig: true,
        actions: [{ name: action, fields: [], scope: { id: scope.id } }],
      },
    });
    const actionConfig = await app.db.getRepository('dataSourcesRolesResources.actions', resource.id).findOne({});
    expect(actionConfig.get('scopeId')).toBe(scope.id);
    await app.db.getRepository('departments').create({ values: { id: 101, title: 'Target department' } });
    const memberships = app.db.getRepository('departmentsUsers');
    if (action === 'remove') {
      await memberships.createMany({
        records: [
          { userId: operator.id, departmentId: 101 },
          { userId: target.id, departmentId: 101 },
        ],
      });
    }

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });

    const agent = app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role);
    const denied = await agent.resource('users.departments', target.id)[action]({ values: [101] });

    const targetMemberships = await memberships.find({
      raw: true,
      filter: { userId: target.id, departmentId: 101 },
    });
    expect(targetMemberships).toHaveLength(action === 'add' ? 0 : 1);
    expect(denied.status).toBe(403);

    const allowed = await agent.resource('users.departments', operator.id)[action]({ values: [101] });
    expect(allowed.status).toBe(200);
    const operatorMemberships = await memberships.find({
      raw: true,
      filter: { userId: operator.id, departmentId: 101 },
    });
    expect(operatorMemberships).toHaveLength(action === 'add' ? 1 : 0);
  });
});
