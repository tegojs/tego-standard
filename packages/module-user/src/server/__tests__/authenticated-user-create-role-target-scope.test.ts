import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated user creation role target scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each(['key', 'object'])(
    'does not assign a hidden role during user creation using a role %s',
    async (roleShape) => {
      app = await createMockServer({
        acl: true,
        database: { dialect: 'sqlite', storage: ':memory:' },
        plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
      });
      const operatorRole = 'user-create-role-scope-operator';
      const visibleRole = 'user-create-role-scope-visible';
      const hiddenRole = 'user-create-role-scope-hidden';
      const password = 'user-create-role-scope-password';
      await app.db.getRepository('roles').create({
        values: { name: operatorRole, strategy: { actions: [] }, snippets: [] },
      });
      await app.db.getRepository('roles').create({
        values: { name: visibleRole, title: 'Visible role', strategy: { actions: [] }, snippets: [] },
      });
      await app.db.getRepository('roles').create({
        values: { name: hiddenRole, title: 'Hidden role', strategy: { actions: [] }, snippets: [] },
      });
      const users = app.db.getRepository('users');
      const operator = await users.create({ values: { username: operatorRole, password, roles: [operatorRole] } });
      const roles = app.db.getRepository('roles');
      const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
        values: {
          dataSourceKey: 'main',
          name: 'Only visible roles',
          resourceName: 'roles',
          scope: { name: visibleRole },
        },
      });
      const rolesResource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: operatorRole,
          name: 'roles',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['name', 'title'], scope: { id: scope.id } }],
        },
      });
      const roleListAction = await app.db
        .getRepository('dataSourcesRolesResources.actions', rolesResource.id)
        .findOne({ filter: { name: 'list' } });
      expect(roleListAction.get('scopeId')).toBe(scope.id);
      const usersResource = await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: operatorRole,
          name: 'users',
          usingActionsConfig: true,
          actions: [{ name: 'create', fields: ['id', 'username', 'password', 'roles'] }],
        },
      });
      const userCreateAction = await app.db
        .getRepository('dataSourcesRolesResources.actions', usersResource.id)
        .findOne({ filter: { name: 'create' } });
      expect(userCreateAction.get('fields')).toContain('roles');

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

      const listedRoles = await agent.resource('roles').list({ fields: ['name'], pagination: false });
      expect(listedRoles.status).toBe(200);
      expect(listedRoles.body.data.map(({ name }) => name)).toEqual([visibleRole]);
      const memberships = app.db.getRepository('rolesUsers');
      const allowed = await agent.resource('users').create({
        values: {
          username: 'user-created-with-visible-role',
          password: 'user-created-with-visible-role-password',
          roles: [roleShape === 'key' ? visibleRole : { name: visibleRole }],
        },
      });
      expect(allowed.status).toBe(200);
      const allowedUser = await users.findOne({ filter: { username: 'user-created-with-visible-role' } });
      expect(
        await memberships.find({ filter: { userId: allowedUser.id, roleName: visibleRole }, raw: true }),
      ).toHaveLength(1);
      const usersBefore = await users.find({ raw: true, sort: ['id'] });
      const rolesBefore = await roles.find({ raw: true, sort: ['name'] });
      const membershipsBefore = await memberships.find({ raw: true, sort: ['userId', 'roleName'] });

      const response = await agent.resource('users').create({
        values: {
          username: 'user-created-with-hidden-role',
          password: 'user-created-with-hidden-role-password',
          roles: [roleShape === 'key' ? hiddenRole : { name: hiddenRole }],
        },
      });

      const createdUser = await users.findOne({
        filter: { username: 'user-created-with-hidden-role' },
        fields: ['id'],
      });
      const hiddenRoleMemberships = createdUser
        ? await memberships.find({ filter: { userId: createdUser.id, roleName: hiddenRole }, raw: true })
        : [];
      expect({
        status: response.status,
        hasData: Object.hasOwn(response.body, 'data'),
        userCreated: Boolean(createdUser),
        hiddenRoleMembershipCount: hiddenRoleMemberships.length,
      }).toEqual({ status: 403, hasData: false, userCreated: false, hiddenRoleMembershipCount: 0 });
      expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
      expect(await roles.find({ raw: true, sort: ['name'] })).toEqual(rolesBefore);
      expect(await memberships.find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(membershipsBefore);
    },
  );

  it.each([
    { name: 'ignores roles excluded by the create whitelist', includeRoles: false, expectedStatus: 200 },
    { name: 'denies role assignment without roles:list permission', includeRoles: true, expectedStatus: 403 },
  ])('$name', async ({ includeRoles, expectedStatus }) => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const operatorRole = 'user-create-no-roles-field-operator';
    const password = 'user-create-no-roles-field-password';
    await app.db.getRepository('roles').create({
      values: { name: operatorRole, strategy: { actions: [] }, snippets: [] },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: operatorRole, password, roles: [operatorRole] } });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: operatorRole,
        name: 'users',
        usingActionsConfig: true,
        actions: [
          { name: 'create', fields: includeRoles ? ['username', 'nickname', 'roles'] : ['username', 'nickname'] },
        ],
      },
    });
    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const rolesBefore = await app.db.getRepository('roles').find({ raw: true, sort: ['name'] });
    const memberships = app.db.getRepository('rolesUsers');
    const membershipsBefore = await memberships.find({ raw: true, sort: ['userId', 'roleName'] });

    const response = await app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', operatorRole)
      .resource('users')
      .create({
        values: { username: 'user-created-without-role-field', nickname: 'Created', roles: [{ name: 'admin' }] },
      });

    expect(response.status).toBe(expectedStatus);
    if (expectedStatus === 403) {
      expect(response.body).not.toHaveProperty('data');
      expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
      expect(await memberships.find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(membershipsBefore);
      expect(await app.db.getRepository('roles').find({ raw: true, sort: ['name'] })).toEqual(rolesBefore);
      return;
    }
    const createdUser = await users.findOne({ filter: { username: 'user-created-without-role-field' } });
    expect(createdUser.get('nickname')).toBe('Created');
    expect(await memberships.find({ filter: { userId: createdUser.id }, fields: ['roleName'], raw: true })).toEqual([
      expect.objectContaining({ roleName: 'member' }),
    ]);
    expect(
      await memberships.find({ filter: { userId: { $ne: createdUser.id } }, raw: true, sort: ['userId', 'roleName'] }),
    ).toEqual(membershipsBefore);
    expect(await app.db.getRepository('roles').find({ raw: true, sort: ['name'] })).toEqual(rolesBefore);
  });
});
