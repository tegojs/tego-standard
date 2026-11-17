import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated department member target scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('allows in-scope members and rejects out-of-scope users when linking a department', async () => {
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
    const role = 'department-member-target-scope-operator';
    const password = 'department-member-target-scope-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: ['departments:add'] }, snippets: ['pm.department'] },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: role, password, roles: [role] },
    });
    const visibleTarget = await users.create({ values: { username: 'visible-member', roles: ['member'] } });
    const hiddenTarget = await users.create({ values: { username: 'hidden-member', roles: ['member'] } });
    await app.db.getRepository('departments').create({ values: { id: 101, title: 'Target department' } });

    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Only operator and visible member',
        resourceName: 'users',
        scope: { id: { $in: [operator.id, visibleTarget.id] } },
      },
    });
    const usersResource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'users',
        usingActionsConfig: true,
        actions: [
          { name: 'list', fields: ['id', 'username'], scope: { id: scope.id } },
          { name: 'add', fields: ['id'], scope: { id: scope.id } },
        ],
      },
    });
    const userAddAction = await app.db
      .getRepository('dataSourcesRolesResources.actions', usersResource.id)
      .findOne({ filter: { name: 'add' } });
    expect(userAddAction.get('scopeId')).toBe(scope.id);
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'departments.members',
        usingActionsConfig: true,
        actions: [{ name: 'add', fields: [] }],
      },
    });

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

    const visibleUsers = await agent.resource('users').list({ fields: ['id'] });
    expect(visibleUsers.status).toBe(200);
    expect(visibleUsers.body.data.map(({ id }) => id)).toEqual([operator.id, visibleTarget.id]);

    const memberships = app.db.getRepository('departmentsUsers');
    const allowed = await agent.resource('departments.members', 101).add({ values: [visibleTarget.id] });
    expect(allowed.status).toBe(200);
    expect(await memberships.find({ raw: true, filter: { departmentId: 101, userId: visibleTarget.id } })).toHaveLength(
      1,
    );

    const denied = await agent.resource('departments.members', 101).add({ values: [hiddenTarget.id] });
    expect(await memberships.find({ raw: true, filter: { departmentId: 101, userId: hiddenTarget.id } })).toHaveLength(
      0,
    );
    expect(denied.status).toBe(403);
  });
});
