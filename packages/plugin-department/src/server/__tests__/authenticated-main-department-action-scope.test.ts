import { createMockServer, type MockServer } from '@tachybase/test';

import PluginDepartmentServer from '../plugin';

describe('authenticated main department action scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not change another user outside the persisted users action scope', async () => {
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
    const role = 'main-department-scoped-operator';
    const password = 'main-department-scoped-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: 'main-department-scoped-operator', password, roles: [role] },
    });
    const target = await users.create({ values: { username: 'main-department-scoped-target', roles: ['member'] } });
    const scopeFilter = { id: { $eq: operator.id } };
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: { dataSourceKey: 'main', name: 'Only operator user', resourceName: 'users', scope: scopeFilter },
    });
    const resource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'users',
        usingActionsConfig: true,
        actions: [{ name: 'setMainDepartment', fields: [], scope: { id: scope.id } }],
      },
    });
    const storedAction = await app.db.getRepository('dataSourcesRolesResources.actions', resource.id).findOne({});
    expect(storedAction.get('scopeId')).toBe(scope.id);
    expect(
      (await app.db.getRepository('dataSourcesRolesResourcesScopes').findOne({ filterByTk: scope.id })).get('scope'),
    ).toEqual(scopeFilter);

    await app.db.getRepository('departments').createMany({
      records: [
        { id: 101, title: 'Original main department' },
        { id: 102, title: 'Other department' },
      ],
    });
    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.createMany({
      records: [
        { userId: operator.id, departmentId: 101, isMain: true, isOwner: false },
        { userId: target.id, departmentId: 101, isMain: true, isOwner: true },
        { userId: target.id, departmentId: 102, isMain: false, isOwner: false },
      ],
    });
    const readMemberships = async () =>
      (await memberships.find({ raw: true, sort: ['userId', 'departmentId'] })).map((row) => ({
        ...row,
        isMain: Boolean(row.isMain),
        isOwner: Boolean(row.isOwner),
      }));
    const before = await readMemberships();

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.user).toMatchObject({ id: operator.id, hasPassword: true });

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role)
      .resource('users')
      .setMainDepartment({ values: { userId: target.id, departmentId: 102 } });

    expect(await readMemberships()).toEqual(before);
    expect(response.status).toBe(200);
  });

  it('does not assign a department outside the persisted department list scope', async () => {
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
    const role = 'main-department-target-scope-operator';
    const password = 'main-department-target-scope-password';
    await app.db.getRepository('roles').create({ values: { name: role, strategy: { actions: [] }, snippets: [] } });
    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: 'main-department-target-scope-operator', password, roles: [role] },
    });
    const target = await users.create({
      values: { username: 'main-department-target-scope-target', roles: ['member'] },
    });
    const userScope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Target user',
        resourceName: 'users',
        scope: { id: { $eq: target.id } },
      },
    });
    const departmentScope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Only visible department',
        resourceName: 'departments',
        scope: { id: { $eq: 101 } },
      },
    });
    await app.db.getRepository('dataSourcesRolesResources').createMany({
      records: [
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'users',
          usingActionsConfig: true,
          actions: [{ name: 'setMainDepartment', fields: [], scope: { id: userScope.id } }],
        },
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'departments',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id'], scope: { id: departmentScope.id } }],
        },
      ],
    });
    await app.db.getRepository('departments').createMany({
      records: [
        { id: 101, title: 'Visible department' },
        { id: 102, title: 'Hidden department' },
      ],
    });
    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.createMany({
      records: [
        { userId: target.id, departmentId: 101, isMain: true, isOwner: false },
        { userId: target.id, departmentId: 102, isMain: false, isOwner: false },
      ],
    });
    const before = await memberships.find({ raw: true, sort: ['userId', 'departmentId'] });

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
    const response = await agent
      .resource('users')
      .setMainDepartment({ values: { userId: target.id, departmentId: 102 } });

    expect(await memberships.find({ raw: true, sort: ['userId', 'departmentId'] })).toEqual(before);
    expect(response.status).toBe(403);
  });
});
