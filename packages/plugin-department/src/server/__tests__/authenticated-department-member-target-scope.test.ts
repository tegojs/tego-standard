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

  it('rejects removing department members outside the target users remove scope', async () => {
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
    const role = 'department-member-remove-target-scope-operator';
    const password = 'department-member-remove-target-scope-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: ['departments:remove'] }, snippets: ['pm.department'] },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
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
          { name: 'remove', fields: ['id'], scope: { id: scope.id } },
        ],
      },
    });
    const userListAction = await app.db
      .getRepository('dataSourcesRolesResources.actions', usersResource.id)
      .findOne({ filter: { name: 'list' } });
    expect(userListAction.get('scopeId')).toBe(scope.id);
    const userRemoveAction = await app.db
      .getRepository('dataSourcesRolesResources.actions', usersResource.id)
      .findOne({ filter: { name: 'remove' } });
    expect(userRemoveAction.get('scopeId')).toBe(scope.id);
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'departments',
        usingActionsConfig: true,
        actions: [{ name: 'remove', fields: ['id'] }],
      },
    });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'departments.members',
        usingActionsConfig: true,
        actions: [{ name: 'remove', fields: ['id'] }],
      },
    });

    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.createMany({
      records: [
        { departmentId: 101, userId: visibleTarget.id },
        { departmentId: 101, userId: hiddenTarget.id },
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

    const visibleUsers = await agent.resource('users').list({ fields: ['id'] });
    expect(visibleUsers.status).toBe(200);
    expect(visibleUsers.body.data.map(({ id }) => id)).toEqual([operator.id, visibleTarget.id]);

    const denied = await agent.resource('departments.members', 101).remove({ values: [hiddenTarget.id] });
    expect(await memberships.find({ raw: true, filter: { departmentId: 101, userId: hiddenTarget.id } })).toHaveLength(
      1,
    );
    expect(denied.status).toBe(403);

    const allowed = await agent.resource('departments.members', 101).remove({ values: [visibleTarget.id] });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(await memberships.find({ raw: true, filter: { departmentId: 101, userId: visibleTarget.id } })).toHaveLength(
      0,
    );
  });

  it('applies users:list scope when reading department members', async () => {
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
    const role = 'department-member-list-scope-operator';
    const password = 'department-member-list-scope-password';
    await app.db
      .getRepository('roles')
      .create({ values: { name: role, strategy: { actions: [] }, snippets: ['pm.department'] } });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
    const visibleTarget = await users.create({ values: { username: 'visible-member', roles: ['member'] } });
    const hiddenTarget = await users.create({ values: { username: 'hidden-member', roles: ['member'] } });
    await app.db.getRepository('departments').create({ values: { id: 101, title: 'Target department' } });

    const userScope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
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
        actions: [{ name: 'list', fields: ['id', 'username'], scope: { id: userScope.id } }],
      },
    });
    const userListAction = await app.db
      .getRepository('dataSourcesRolesResources.actions', usersResource.id)
      .findOne({});
    expect(userListAction.get('scopeId')).toBe(userScope.id);
    const membersResource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'departments.members',
        usingActionsConfig: true,
        actions: [{ name: 'list', fields: ['id', 'username'] }],
      },
    });
    expect(
      (await app.db.getRepository('dataSourcesRolesResources.actions', membersResource.id).findOne({})).get('name'),
    ).toBe('list');

    const memberships = app.db.getRepository('departmentsUsers');
    await memberships.createMany({
      records: [
        { departmentId: 101, userId: operator.id },
        { departmentId: 101, userId: visibleTarget.id },
        { departmentId: 101, userId: hiddenTarget.id },
      ],
    });
    const membershipsBefore = await memberships.find({ raw: true, sort: ['departmentId', 'userId'] });
    const usersBefore = await users.find({ raw: true, sort: ['id'] });

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
    const visibleUsers = await agent.resource('users').list({ fields: ['id'], sort: ['id'], pagination: false });
    expect(visibleUsers.status).toBe(200);
    expect(visibleUsers.body.data.map(({ id }) => id)).toEqual([operator.id, visibleTarget.id]);

    const members = agent.resource('departments.members', 101);
    const unfiltered = await members.list({ fields: ['id', 'username'], sort: ['id'], pagination: false });
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.data.map(({ id }) => id)).toEqual([operator.id, visibleTarget.id]);
    const response = await members.list({
      fields: ['id', 'username'],
      filter: { id: { $notIn: [operator.id] } },
      sort: ['id'],
      pagination: false,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.map(({ id }) => id)).toEqual([visibleTarget.id]);
    expect(response.body.data.some(({ id }) => id === hiddenTarget.id)).toBe(false);
    expect(await memberships.find({ raw: true, sort: ['departmentId', 'userId'] })).toEqual(membershipsBefore);
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
  });

  it('denies department member lists when users:list permission is absent', async () => {
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
    const role = 'department-member-list-no-target-permission-operator';
    const password = 'department-member-list-no-target-permission-password';
    await app.db
      .getRepository('roles')
      .create({ values: { name: role, strategy: { actions: [] }, snippets: ['pm.department'] } });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
    const member = await users.create({ values: { username: 'member-without-list-grant', roles: ['member'] } });
    await app.db.getRepository('departments').create({ values: { id: 101, title: 'Target department' } });
    await app.db.getRepository('departmentsUsers').create({
      values: { departmentId: 101, userId: member.id },
    });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: role,
        name: 'departments.members',
        usingActionsConfig: true,
        actions: [{ name: 'list', fields: ['id', 'username'] }],
      },
    });

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
      .resource('departments.members', 101)
      .list({ fields: ['id', 'username'], pagination: false });

    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  });
});
