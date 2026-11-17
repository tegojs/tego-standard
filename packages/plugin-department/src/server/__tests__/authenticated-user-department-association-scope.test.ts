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

  it.each(['add', 'remove'] as const)(
    'does not %s a department outside the target collection ACL scope',
    async (action) => {
      app = await createMockServer({
        acl: true,
        database: { dialect: 'sqlite', storage: ':memory:' },
        plugins: [
          'acl',
          'auth',
          'users',
          'data-source-manager',
          [
            PluginDepartmentServer,
            { name: 'department', packageName: '@tachybase/plugin-department', workspaceSource: true },
          ],
        ],
      });
      const role = 'department-target-scope-operator';
      const password = 'department-target-scope-password';
      await app.db
        .getRepository('roles')
        .create({ values: { name: role, strategy: { actions: [] }, snippets: ['pm.department'] } });
      const operator = await app.db.getRepository('users').create({
        values: { username: role, password, roles: [role] },
      });
      await app.db.getRepository('departments').createMany({
        records: [
          { id: 101, title: 'Visible department' },
          { id: 102, title: 'Hidden department' },
        ],
      });
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: {
          dataSourceKey: 'main',
          name: 'Only visible department',
          resourceName: 'departments',
          scope: { id: { $eq: 101 } },
        },
      });
      const targetResource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: role,
          name: 'departments',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id'], scope: { id: scope.id } }],
        },
      });
      const targetAction = await app.db
        .getRepository('dataSourcesRolesResources.actions', targetResource.id)
        .findOne({});
      expect(targetAction.get('scopeId')).toBe(scope.id);

      const memberships = app.db.getRepository('departmentsUsers');
      if (action === 'remove') await memberships.create({ values: { userId: operator.id, departmentId: 102 } });

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

      const visible = await agent.resource('departments').list({ fields: ['id'] });
      expect(visible.status).toBe(200);
      expect(visible.body.data.map(({ id }) => id)).toEqual([101]);

      const before = await memberships.find({ raw: true, filter: { userId: operator.id, departmentId: 102 } });
      const denied = await agent.resource('users.departments', operator.id)[action]({ values: [102] });
      expect(denied.status).toBe(403);
      expect(await memberships.find({ raw: true, filter: { userId: operator.id, departmentId: 102 } })).toEqual(before);
    },
  );

  it('does not return associated departments outside the target collection ACL scope', async () => {
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
    const role = 'user-department-association-list-operator';
    const password = 'user-department-association-list-password';
    await app.db
      .getRepository('roles')
      .create({ values: { name: role, strategy: { actions: [] }, snippets: ['pm.department'] } });
    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: 'user-department-association-list-operator', password, roles: [role] },
    });
    const target = await users.create({
      values: { username: 'user-department-association-list-target', roles: ['member'] },
    });
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
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
          name: 'departments',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'title', 'parent'], scope: { id: scope.id } }],
        },
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'users.departments',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'title', 'parent'] }],
        },
      ],
    });
    await app.db.getRepository('departments').createMany({
      records: [
        { id: 100, title: 'Hidden parent department' },
        { id: 101, title: 'Visible department', parentId: 100 },
        { id: 102, title: 'Hidden department' },
      ],
    });
    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.createMany({
      records: [
        { userId: target.id, departmentId: 101 },
        { userId: target.id, departmentId: 102 },
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
    const visibleUserDepartments = await agent.resource('users.departments', target.id).list({
      appends: ['parent(recursively=true)'],
      pagination: false,
    });

    expect(visibleUserDepartments.status).toBe(200);
    expect(visibleUserDepartments.body.data.map(({ id }) => id)).toEqual([101]);
    expect(visibleUserDepartments.body.data[0]).not.toHaveProperty('parent');
    const filteredOutDepartment = await agent.resource('users.departments', target.id).list({
      filter: { id: { $eq: 102 } },
    });
    expect(filteredOutDepartment.status).toBe(200);
    expect(filteredOutDepartment.body.data).toEqual([]);
  });

  it('denies associated department lists when the target collection list permission is absent', async () => {
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
    const role = 'user-department-association-no-target-list-operator';
    const password = 'user-department-association-no-target-list-password';
    await app.db
      .getRepository('roles')
      .create({ values: { name: role, strategy: { actions: [] }, snippets: ['pm.department'] } });
    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: role, password, roles: [role] },
    });
    const target = await users.create({
      values: { username: 'user-department-association-no-target-list-target', roles: ['member'] },
    });
    await app.db.getRepository('dataSourcesRolesResources').createMany({
      records: [
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'departments',
          usingActionsConfig: true,
          actions: [{ name: 'get', fields: ['id', 'title'] }],
        },
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'users.departments',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'title'] }],
        },
      ],
    });
    await app.db.getRepository('departments').create({ values: { id: 101, title: 'Hidden department' } });
    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.create({ values: { userId: target.id, departmentId: 101 } });

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

    const departmentsList = await agent.resource('departments').list({ fields: ['id'] });
    expect(departmentsList.status).toBe(403);
    expect(await memberships.find({ raw: true, filter: { userId: target.id, departmentId: 101 } })).toHaveLength(1);

    const associatedDepartments = await agent.resource('users.departments', target.id).list({
      fields: ['id'],
      pagination: false,
    });
    expect(associatedDepartments.status).toBe(403);
    expect(associatedDepartments.body.data).not.toEqual([{ id: 101 }]);
  });
});
