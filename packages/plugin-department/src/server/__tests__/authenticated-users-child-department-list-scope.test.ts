import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated users list with child departments', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not return users from direct or descendant departments outside the department list scope', async () => {
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
    const role = 'child-department-list-operator';
    const unrestrictedRole = 'child-department-list-unrestricted-operator';
    const hiddenRootRole = 'child-department-list-hidden-root-operator';
    const password = 'child-department-list-password';
    await app.db
      .getRepository('roles')
      .create({ values: { name: role, strategy: { actions: [] }, snippets: ['pm.department'] } });
    await app.db
      .getRepository('roles')
      .create({ values: { name: unrestrictedRole, strategy: { actions: [] }, snippets: ['pm.department'] } });
    await app.db
      .getRepository('roles')
      .create({ values: { name: hiddenRootRole, strategy: { actions: [] }, snippets: ['pm.department'] } });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
    const unrestrictedOperator = await users.create({
      values: { username: unrestrictedRole, password, roles: [unrestrictedRole] },
    });
    const hiddenRootOperator = await users.create({
      values: { username: hiddenRootRole, password, roles: [hiddenRootRole] },
    });
    const visibleUser = await users.create({ values: { username: 'visible-department-user', roles: ['member'] } });
    const hiddenUser = await users.create({
      values: { username: 'restricted-child-department-user', roles: ['member'] },
    });
    const departmentScope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Only visible department',
        resourceName: 'departments',
        scope: { id: { $eq: 101 } },
      },
    });
    const hiddenRootScope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Only visible child department',
        resourceName: 'departments',
        scope: { id: { $eq: 102 } },
      },
    });
    await app.db.getRepository('dataSourcesRolesResources').createMany({
      records: [
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'departments',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'title'], scope: { id: departmentScope.id } }],
        },
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'users',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'username'] }],
        },
        {
          dataSourceKey: 'main',
          roleName: hiddenRootRole,
          name: 'departments',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'title'], scope: { id: hiddenRootScope.id } }],
        },
        {
          dataSourceKey: 'main',
          roleName: hiddenRootRole,
          name: 'users',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'username'] }],
        },
      ],
    });
    await app.db.getRepository('departments').createMany({
      records: [
        { id: 101, title: 'Visible department', isLeaf: false },
        { id: 102, title: 'Restricted child department', parentId: 101, isLeaf: true },
      ],
    });
    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.createMany({
      records: [
        { userId: visibleUser.id, departmentId: 101 },
        { userId: hiddenUser.id, departmentId: 102 },
      ],
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

    const visibleDepartments = await agent.resource('departments').list({ fields: ['id'] });
    expect(visibleDepartments.status).toBe(200);
    expect(visibleDepartments.body.data.map(({ id }) => id)).toEqual([101]);

    const departmentMembers = await agent.resource('users').list({
      filter: { departments: { id: 101 }, showChildren: true },
      fields: ['id', 'username'],
      pagination: false,
    });
    expect(departmentMembers.status).toBe(200);
    expect(departmentMembers.body.data.map(({ id }) => id)).toEqual([visibleUser.id]);

    const unrestrictedSignIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: unrestrictedOperator.username,
      password,
    });
    expect(unrestrictedSignIn.status).toBe(200);
    const unrestrictedAgent = app
      .agent()
      .set('Authorization', `Bearer ${unrestrictedSignIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', unrestrictedRole);

    const unrestrictedDepartments = await unrestrictedAgent.resource('departments').list({ fields: ['id'] });
    expect(unrestrictedDepartments.status).toBe(200);
    expect(unrestrictedDepartments.body.data.map(({ id }) => id)).toEqual([101, 102]);
    const unrestrictedDepartmentMembers = await unrestrictedAgent.resource('users').list({
      filter: { departments: { id: 101 }, showChildren: true },
      fields: ['id', 'username'],
      pagination: false,
    });
    expect(unrestrictedDepartmentMembers.status).toBe(200);
    expect(unrestrictedDepartmentMembers.body.data.map(({ id }) => id)).toEqual([visibleUser.id, hiddenUser.id]);

    const hiddenRootSignIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: hiddenRootOperator.username,
      password,
    });
    expect(hiddenRootSignIn.status).toBe(200);
    const hiddenRootAgent = app
      .agent()
      .set('Authorization', `Bearer ${hiddenRootSignIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', hiddenRootRole);

    const visibleChildOnly = await hiddenRootAgent.resource('departments').list({ fields: ['id'] });
    expect(visibleChildOnly.status).toBe(200);
    expect(visibleChildOnly.body.data.map(({ id }) => id)).toEqual([102]);
    const hiddenRootMembers = await hiddenRootAgent.resource('users').list({
      filter: { departments: { id: 101 }, showChildren: true },
      fields: ['id', 'username'],
      pagination: false,
    });
    expect(hiddenRootMembers.status).toBe(403);

    const visibleDirectMembers = await hiddenRootAgent.resource('users').list({
      filter: { departments: { id: 102 }, showChildren: false },
      fields: ['id', 'username'],
      pagination: false,
    });
    expect(visibleDirectMembers.status).toBe(200);
    expect(visibleDirectMembers.body.data.map(({ id }) => id)).toEqual([hiddenUser.id]);

    const hiddenDirectMembers = await hiddenRootAgent.resource('users').list({
      filter: { departments: { id: 101 }, showChildren: false },
      fields: ['id', 'username'],
      pagination: false,
    });
    expect(hiddenDirectMembers.status).toBe(403);
    expect(hiddenDirectMembers.body.data ?? []).toEqual([]);
  });
});
