import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated user creation status target scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not create a user with a status outside the operator status-list scope', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const role = 'user-create-status-scope-operator';
    const password = 'user-create-status-scope-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: ['pm.users.statuses'] },
    });
    const statuses = app.db.getRepository('userStatuses');
    await statuses.create({ values: { key: 'active', title: 'Active', allowLogin: true, isSystemDefined: true } });
    await statuses.create({ values: { key: 'disabled', title: 'Disabled', allowLogin: false, isSystemDefined: true } });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
    const statusScope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: {
        dataSourceKey: 'main',
        name: 'Active status only',
        resourceName: 'userStatuses',
        scope: { key: 'active' },
      },
    });
    await app.db.getRepository('dataSourcesRolesResources').createMany({
      records: [
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'userStatuses',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['key', 'title'], scope: { id: statusScope.id } }],
        },
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'users',
          usingActionsConfig: true,
          actions: [{ name: 'create', fields: ['username', 'password', 'statusInfo'] }],
        },
      ],
    });

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const agent = app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', role);
    const visibleStatuses = await agent.resource('userStatuses').list({ fields: ['key'], pagination: false });
    expect(visibleStatuses.status).toBe(200);
    expect(visibleStatuses.body.data.map(({ key }) => key)).toEqual(['active']);

    const allowed = await agent.resource('users').create({
      values: {
        username: 'user-created-with-visible-status',
        password: 'user-created-with-visible-status-password',
        statusInfo: { key: 'active' },
      },
    });
    expect(allowed.status).toBe(200);
    const allowedUser = await users.findOne({ filter: { username: 'user-created-with-visible-status' } });
    expect(allowedUser.get('status')).toBe('active');

    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const statusesBefore = await statuses.find({ raw: true, sort: ['key'] });
    const rolesBefore = await app.db.getRepository('roles').find({ raw: true, sort: ['name'] });
    const memberships = app.db.getRepository('rolesUsers');
    const membershipsBefore = await memberships.find({ raw: true, sort: ['userId', 'roleName'] });
    const histories = app.db.getRepository('userStatusHistories');
    const historiesBefore = await histories.find({ raw: true, sort: ['id'] });

    const response = await agent.resource('users').create({
      values: {
        username: 'user-created-with-hidden-status',
        password: 'user-created-with-hidden-status-password',
        statusInfo: { key: 'disabled' },
      },
    });

    const hiddenUser = await users.findOne({ filter: { username: 'user-created-with-hidden-status' } });
    expect({
      status: response.status,
      hasData: Object.hasOwn(response.body, 'data'),
      hiddenUserStatus: hiddenUser?.get('status') ?? null,
    }).toEqual({ status: 403, hasData: false, hiddenUserStatus: null });
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await statuses.find({ raw: true, sort: ['key'] })).toEqual(statusesBefore);
    expect(await app.db.getRepository('roles').find({ raw: true, sort: ['name'] })).toEqual(rolesBefore);
    expect(await memberships.find({ raw: true, sort: ['userId', 'roleName'] })).toEqual(membershipsBefore);
    expect(await histories.find({ raw: true, sort: ['id'] })).toEqual(historiesBefore);
  });
});
