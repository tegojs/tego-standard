import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated user update role target scope', () => {
  let app: MockServer;
  const operatorRole = 'user-update-role-scope-operator';
  const initialRole = 'user-update-role-scope-initial';
  const visibleRole = 'user-update-role-scope-visible';
  const hiddenRole = 'user-update-role-scope-hidden';

  afterEach(async () => {
    await app?.destroy();
  });

  const setup = async ({ includeRoles = true, listRoles = true, editableTarget = true } = {}) => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const roles = app.db.getRepository('roles');
    for (const name of [operatorRole, initialRole, visibleRole, hiddenRole]) {
      await roles.create({ values: { name, strategy: { actions: [] }, snippets: [] } });
    }
    const users = app.db.getRepository('users');
    const memberships = app.db.getRepository('rolesUsers');
    const password = 'user-update-role-scope-password';
    const operator = await users.create({ values: { username: operatorRole, password, roles: [operatorRole] } });
    const target = await users.create({
      values: { username: 'user-update-role-scope-target', nickname: 'Original', roles: [initialRole] },
    });
    const scopes = app.db.getRepository('dataSourcesRolesResourcesScopes');
    const roleScope = await scopes.create({
      values: {
        dataSourceKey: 'main',
        name: 'Visible role targets',
        resourceName: 'roles',
        scope: { name: { $in: [initialRole, visibleRole] } },
      },
    });
    const userScope = await scopes.create({
      values: {
        dataSourceKey: 'main',
        name: 'Editable user',
        resourceName: 'users',
        scope: { id: editableTarget ? target.id : operator.id },
      },
    });
    if (listRoles) {
      await app.db.getRepository('dataSourcesRolesResources').create({
        values: {
          dataSourceKey: 'main',
          roleName: operatorRole,
          name: 'roles',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['name'], scope: { id: roleScope.id } }],
        },
      });
    }
    const usersResource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: operatorRole,
        name: 'users',
        usingActionsConfig: true,
        actions: [
          { name: 'update', fields: includeRoles ? ['nickname', 'roles'] : ['nickname'], scope: { id: userScope.id } },
        ],
      },
    });
    const updateAction = await app.db
      .getRepository('dataSourcesRolesResources.actions', usersResource.id)
      .findOne({ filter: { name: 'update' } });
    expect(updateAction.get('fields')).toEqual(includeRoles ? ['nickname', 'roles'] : ['nickname']);
    expect(updateAction.get('scopeId')).toBe(userScope.id);

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
    if (!listRoles) {
      const listed = await agent.resource('roles').list({ fields: ['name'], pagination: false });
      expect(listed.status).toBe(403);
      expect(listed.body).not.toHaveProperty('data');
    }
    return { agent, users, roles, memberships, target };
  };

  it.each(['key', 'object'])('rejects a hidden role in the user edit form using a role %s', async (roleShape) => {
    const { agent, users, roles, memberships, target } = await setup();
    const listed = await agent.resource('roles').list({ fields: ['name'], pagination: false, sort: ['name'] });
    expect(listed.status).toBe(200);
    expect(listed.body.data.map(({ name }) => name)).toEqual([initialRole, visibleRole]);
    const allowed = await agent.resource('users').update({
      filterByTk: target.id,
      values: { nickname: 'Allowed edit', roles: [roleShape === 'key' ? visibleRole : { name: visibleRole }] },
    });
    expect(allowed.status).toBe(200);
    expect((await users.findOne({ filterByTk: target.id })).get('nickname')).toBe('Allowed edit');
    expect(await memberships.find({ filter: { userId: target.id }, fields: ['roleName'], raw: true })).toEqual([
      expect.objectContaining({ roleName: visibleRole }),
    ]);
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const rolesBefore = await roles.find({ raw: true, sort: ['name'] });
    const membershipsBefore = await memberships.find({ raw: true, sort: ['userId', 'roleName'] });

    const response = await agent.resource('users').update({
      filterByTk: target.id,
      values: {
        nickname: 'Must not change',
        roles: roleShape === 'key' ? [visibleRole, hiddenRole] : [{ name: visibleRole }, { name: hiddenRole }],
      },
    });

    const persistedUser = await users.findOne({ filterByTk: target.id });
    expect({
      status: response.status,
      hasData: Object.hasOwn(response.body, 'data'),
      nickname: persistedUser.get('nickname'),
      hiddenRoleMembershipCount: await memberships.count({ filter: { userId: target.id, roleName: hiddenRole } }),
    }).toEqual({ status: 403, hasData: false, nickname: 'Allowed edit', hiddenRoleMembershipCount: 0 });
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await roles.find({ raw: true, sort: ['name'] })).toEqual(rolesBefore);
    expect(await memberships.find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(membershipsBefore);
  });

  it.each([
    {
      name: 'ignores roles excluded by the update whitelist',
      includeRoles: false,
      listRoles: false,
      editableTarget: true,
      filterMismatch: false,
      expectedStatus: 200,
      expectedNickname: 'Allowed control edit',
    },
    {
      name: 'denies writable roles without roles:list permission',
      includeRoles: true,
      listRoles: false,
      editableTarget: true,
      filterMismatch: false,
      expectedStatus: 403,
      expectedNickname: 'Original',
    },
    {
      name: 'preserves the no-op when the user is outside the update scope',
      includeRoles: true,
      listRoles: true,
      editableTarget: false,
      filterMismatch: false,
      expectedStatus: 200,
      expectedNickname: 'Original',
    },
    {
      name: 'preserves the no-op when the request filter does not match the user',
      includeRoles: true,
      listRoles: true,
      editableTarget: true,
      filterMismatch: true,
      expectedStatus: 200,
      expectedNickname: 'Original',
    },
  ])('$name', async ({ includeRoles, listRoles, editableTarget, filterMismatch, expectedStatus, expectedNickname }) => {
    const { agent, users, roles, memberships, target } = await setup({ includeRoles, listRoles, editableTarget });
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const rolesBefore = await roles.find({ raw: true, sort: ['name'] });
    const membershipsBefore = await memberships.find({ raw: true, sort: ['userId', 'roleName'] });

    const response = await agent.resource('users').update({
      filterByTk: target.id,
      ...(filterMismatch ? { filter: { nickname: 'Does not match' } } : {}),
      values: { nickname: 'Allowed control edit', roles: [{ name: hiddenRole }] },
    });

    expect(response.status).toBe(expectedStatus);
    expect((await users.findOne({ filterByTk: target.id })).get('nickname')).toBe(expectedNickname);
    expect(await roles.find({ raw: true, sort: ['name'] })).toEqual(rolesBefore);
    expect(await memberships.find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(membershipsBefore);
    if (expectedStatus === 403) {
      expect(response.body).not.toHaveProperty('data');
    }
    if (expectedNickname === 'Original') {
      expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
      if (expectedStatus === 200) {
        expect(response.body.data).toEqual([]);
      }
    } else {
      expect(await users.find({ filter: { id: { $ne: target.id } }, raw: true, sort: ['id'] })).toEqual(
        usersBefore.filter(({ id }) => id !== target.id),
      );
    }
  });
});
