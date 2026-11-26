import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated user status association read scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not expand statuses outside the operator status-list scope', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const role = 'status-association-read-scope-operator';
    const password = 'status-association-read-scope-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: ['pm.users.statuses'] },
    });
    const statuses = app.db.getRepository('userStatuses');
    await statuses.create({ values: { key: 'active', title: 'Active', allowLogin: true, isSystemDefined: true } });
    await statuses.create({ values: { key: 'disabled', title: 'Disabled', allowLogin: false, isSystemDefined: true } });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
    const target = await users.create({
      values: {
        username: 'status-association-read-target',
        roles: [role],
        status: 'disabled',
        previousStatus: 'active',
      },
    });
    const scopes = app.db.getRepository('dataSourcesRolesResourcesScopes');
    const statusScope = await scopes.create({
      values: {
        dataSourceKey: 'main',
        name: 'Active status only',
        resourceName: 'userStatuses',
        scope: { key: 'active' },
      },
    });
    const userScope = await scopes.create({
      values: {
        dataSourceKey: 'main',
        name: 'Visible users',
        resourceName: 'users',
        scope: { id: { $in: [operator.id, target.id] } },
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
          actions: [
            {
              name: 'list',
              fields: ['id', 'username', 'statusInfo', 'previousStatusInfo'],
              scope: { id: userScope.id },
            },
          ],
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

    const response = await agent.resource('users').list({
      fields: ['id', 'username', 'statusInfo', 'previousStatusInfo'],
      appends: ['statusInfo', 'previousStatusInfo'],
      filter: { id: target.id },
      pagination: false,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).not.toHaveProperty('statusInfo');
    expect(response.body.data[0].previousStatusInfo).toMatchObject({ key: 'active', title: 'Active' });

    for (const query of [
      { fields: ['id', 'username', 'statusInfo'], pagination: false },
      { fields: ['id', 'username', 'statusInfo'], appends: ['statusInfo.key'], pagination: false },
    ]) {
      const bypass = await agent.resource('users').list({
        ...query,
        filter: { id: target.id },
      });

      expect(bypass.status).toBe(200);
      expect(bypass.body.data[0]).not.toHaveProperty('statusInfo');
    }
  });
});
