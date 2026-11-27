import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated role user target scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('applies users:list scope when reading users assigned to a role', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const operatorRole = 'role-users-target-scope-operator';
    const targetRole = 'role-users-target-scope-target';
    const password = 'role-users-target-scope-password';
    await app.db.getRepository('roles').create({
      values: { name: operatorRole, strategy: { actions: [] }, snippets: ['pm.acl.roles'] },
    });
    await app.db.getRepository('roles').create({
      values: { name: targetRole, strategy: { actions: [] }, snippets: [] },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: operatorRole, password, roles: [operatorRole] } });
    const visibleUser = await users.create({ values: { username: 'visible-role-user', roles: [targetRole] } });
    const hiddenUser = await users.create({ values: { username: 'hidden-role-user', roles: [targetRole] } });

    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Only operator and visible user',
        resourceName: 'users',
        scope: { id: { $in: [operator.id, visibleUser.id] } },
      },
    });
    const usersResource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: operatorRole,
        name: 'users',
        usingActionsConfig: true,
        actions: [{ name: 'list', fields: ['id', 'username'], scope: { id: scope.id } }],
      },
    });
    expect(
      (await app.db.getRepository('dataSourcesRolesResources.actions', usersResource.id).findOne({})).get('scopeId'),
    ).toBe(scope.id);
    const memberships = app.db.getRepository('rolesUsers');
    const membershipsBefore = await memberships.find({ raw: true, sort: ['userId', 'roleName'] });
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
      .set('X-Role', operatorRole);

    const visibleUsers = await agent.resource('users').list({ fields: ['id'], sort: ['id'], pagination: false });
    expect(visibleUsers.status).toBe(200);
    expect(visibleUsers.body.data.map(({ id }) => id)).toEqual([operator.id, visibleUser.id]);

    const response = await agent.resource('roles.users', targetRole).list({
      fields: ['id', 'username'],
      filter: { id: { $notIn: [operator.id] } },
      sort: ['id'],
      pagination: false,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.map(({ id }) => id)).toEqual([visibleUser.id]);
    expect(response.body.data.some(({ id }) => id === hiddenUser.id)).toBe(false);
    const filteredOut = await agent.resource('roles.users', targetRole).list({
      fields: ['id'],
      filter: { id: { $eq: hiddenUser.id } },
      pagination: false,
    });
    expect(filteredOut.status).toBe(200);
    expect(filteredOut.body.data).toEqual([]);
    expect(await memberships.find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(membershipsBefore);
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
  });

  it.each(['values array', 'filterByTk', 'filterByTks'])(
    'rejects assigning users outside the target users:add scope before writing any membership (%s)',
    async (targetParam) => {
      app = await createMockServer({
        acl: true,
        database: { dialect: 'sqlite', storage: ':memory:' },
        plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
      });
      const operatorRole = 'role-users-add-scope-operator';
      const targetRole = 'role-users-add-scope-target';
      const password = 'role-users-add-scope-password';
      const roles = app.db.getRepository('roles');
      await roles.create({
        values: { name: operatorRole, strategy: { actions: [] }, snippets: ['pm.acl.roles'] },
      });
      await roles.create({
        values: { name: targetRole, strategy: { actions: [] }, snippets: [] },
      });
      const users = app.db.getRepository('users');
      const operator = await users.create({ values: { username: operatorRole, password, roles: [operatorRole] } });
      const visibleUser = await users.create({ values: { username: 'visible-role-add-user', roles: ['member'] } });
      const otherVisibleUser = await users.create({
        values: { username: 'other-visible-role-add-user', roles: ['member'] },
      });
      const hiddenUser = await users.create({ values: { username: 'hidden-role-add-user', roles: ['member'] } });
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: {
          dataSourceKey: 'main',
          name: 'Only users permitted for assignment',
          resourceName: 'users',
          scope: { id: { $in: [operator.id, visibleUser.id, otherVisibleUser.id] } },
        },
      });
      const usersResource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: operatorRole,
          name: 'users',
          usingActionsConfig: true,
          actions: [
            { name: 'list', fields: ['id', 'username'] },
            { name: 'add', fields: ['id'], scope: { id: scope.id } },
          ],
        },
      });
      const addAction = await app.db
        .getRepository('dataSourcesRolesResources.actions', usersResource.id)
        .findOne({ filter: { name: 'add' } });
      expect(addAction.get('scopeId')).toBe(scope.id);

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
        .set('X-Role', operatorRole);

      const listedUsers = await agent.resource('users').list({ fields: ['id'], sort: ['id'], pagination: false });
      expect(listedUsers.status).toBe(200);
      expect(listedUsers.body.data.map(({ id }) => id)).toEqual([
        1,
        operator.id,
        visibleUser.id,
        otherVisibleUser.id,
        hiddenUser.id,
      ]);

      const memberships = app.db.getRepository('rolesUsers');
      const usersBefore = await users.find({ raw: true, sort: ['id'] });
      const rolesBefore = await roles.find({ raw: true, sort: ['name'] });
      const allowedParams = {
        'values array': { values: [visibleUser.id] },
        filterByTk: { filterByTk: visibleUser.id, filterByTks: [hiddenUser.id], values: [hiddenUser.id] },
        filterByTks: { filterByTks: [visibleUser.id], values: [hiddenUser.id] },
      }[targetParam];
      const allowed = await agent.resource('roles.users', targetRole).add(allowedParams);
      expect(allowed.status).toBe(200);
      expect(await memberships.find({ raw: true, filter: { roleName: targetRole } })).toEqual([
        expect.objectContaining({ roleName: targetRole, userId: visibleUser.id }),
      ]);
      const membershipsBefore = await memberships.find({ raw: true, sort: ['userId', 'roleName'] });

      const deniedParams = {
        'values array': { values: [otherVisibleUser.id, hiddenUser.id] },
        filterByTk: {
          filterByTk: hiddenUser.id,
          filterByTks: [otherVisibleUser.id],
          values: [otherVisibleUser.id],
        },
        filterByTks: { filterByTks: [otherVisibleUser.id, hiddenUser.id], values: [visibleUser.id] },
      }[targetParam];
      const denied = await agent.resource('roles.users', targetRole).add(deniedParams);

      expect(await memberships.find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(membershipsBefore);
      expect(denied.status).toBe(403);
      expect(denied.body).not.toHaveProperty('data');
      expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
      expect(await roles.find({ raw: true, sort: ['name'] })).toEqual(rolesBefore);
    },
  );

  it('denies role user lists when users:list permission is absent', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const operatorRole = 'role-users-no-target-list-operator';
    const targetRole = 'role-users-no-target-list-target';
    const password = 'role-users-no-target-list-password';
    await app.db.getRepository('roles').create({
      values: { name: operatorRole, strategy: { actions: [] }, snippets: ['pm.acl.roles'] },
    });
    await app.db.getRepository('roles').create({
      values: { name: targetRole, strategy: { actions: [] }, snippets: [] },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: operatorRole, password, roles: [operatorRole] } });
    const target = await users.create({ values: { username: 'role-user-without-target-list', roles: [targetRole] } });
    const memberships = app.db.getRepository('rolesUsers');
    const membershipsBefore = await memberships.find({ raw: true, sort: ['userId', 'roleName'] });
    expect(membershipsBefore).toContainEqual(expect.objectContaining({ userId: target.id, roleName: targetRole }));

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
      .set('X-Role', operatorRole)
      .resource('roles.users', targetRole)
      .list({ fields: ['id', 'username'], pagination: false });

    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    expect(await memberships.find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(membershipsBefore);
  });

  it('rejects removing role users outside the target users:remove scope without partial changes', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const operatorRole = 'role-users-remove-scope-operator';
    const targetRole = 'role-users-remove-scope-target';
    const password = 'role-users-remove-scope-password';
    await app.db.getRepository('roles').create({
      values: { name: operatorRole, strategy: { actions: [] }, snippets: ['pm.acl.roles'] },
    });
    await app.db.getRepository('roles').create({
      values: { name: targetRole, strategy: { actions: [] }, snippets: [] },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: operatorRole, password, roles: [operatorRole] } });
    const visibleUser = await users.create({ values: { username: 'visible-role-remove-user', roles: [targetRole] } });
    const otherVisibleUser = await users.create({
      values: { username: 'other-visible-role-remove-user', roles: [targetRole] },
    });
    const hiddenUser = await users.create({ values: { username: 'hidden-role-remove-user', roles: [targetRole] } });
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Only users permitted for removal',
        resourceName: 'users',
        scope: { id: { $in: [operator.id, visibleUser.id, otherVisibleUser.id] } },
      },
    });
    const usersResource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: operatorRole,
        name: 'users',
        usingActionsConfig: true,
        actions: [{ name: 'remove', fields: ['id'], scope: { id: scope.id } }],
      },
    });
    const removeAction = await app.db
      .getRepository('dataSourcesRolesResources.actions', usersResource.id)
      .findOne({ filter: { name: 'remove' } });
    expect(removeAction.get('scopeId')).toBe(scope.id);

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
      .set('X-Role', operatorRole);

    const memberships = app.db.getRepository('rolesUsers');
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const rolesBefore = await app.db.getRepository('roles').find({ raw: true, sort: ['name'] });
    const allowed = await agent.resource('roles.users', targetRole).remove({ values: [visibleUser.id] });
    expect(allowed.status).toBe(200);
    expect(await memberships.find({ raw: true, filter: { userId: visibleUser.id, roleName: targetRole } })).toEqual([]);

    const membershipsBefore = await memberships.find({ raw: true, sort: ['userId', 'roleName'] });
    const denied = await agent.resource('roles.users', targetRole).remove({
      values: [otherVisibleUser.id, hiddenUser.id],
    });

    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('data');
    expect(await memberships.find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(membershipsBefore);
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await app.db.getRepository('roles').find({ raw: true, sort: ['name'] })).toEqual(rolesBefore);
  });
});
