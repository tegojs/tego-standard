import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated user status history target scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('applies userStatusHistories:list scope to direct and user association reads', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const role = 'status-history-scope-operator';
    const password = 'status-history-scope-password';
    const roles = app.db.getRepository('roles');
    await roles.create({ values: { name: role, strategy: { actions: [] }, snippets: ['pm.users.statuses'] } });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
    const firstUser = await users.create({ values: { username: 'status-history-first', roles: [role] } });
    const secondUser = await users.create({ values: { username: 'status-history-second', roles: [role] } });
    const scopes = app.db.getRepository('dataSourcesRolesResourcesScopes');
    const userScope = await scopes.create({
      values: {
        dataSourceKey: 'main',
        name: 'Visible users',
        resourceName: 'users',
        scope: { id: { $in: [operator.id, firstUser.id, secondUser.id] } },
      },
    });
    const historyScope = await scopes.create({
      values: {
        dataSourceKey: 'main',
        name: 'First user history only',
        resourceName: 'userStatusHistories',
        scope: { userId: firstUser.id },
      },
    });
    await app.db.getRepository('dataSourcesRolesResources').createMany({
      records: [
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'users',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id'], scope: { id: userScope.id } }],
        },
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'userStatusHistories',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'userId', 'toStatus'], scope: { id: historyScope.id } }],
        },
      ],
    });
    const histories = app.db.getRepository('userStatusHistories');
    const firstHistory = await histories.create({
      values: { userId: firstUser.id, toStatus: 'review', reason: 'private first-user reason' },
    });
    const secondHistory = await histories.create({ values: { userId: secondUser.id, toStatus: 'disabled' } });
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

    const direct = await agent.resource('userStatusHistories').list({ fields: ['id', 'userId'], pagination: false });
    expect(direct.status).toBe(200);
    expect(direct.body.data.map(({ id }) => id)).toEqual([firstHistory.id]);

    const firstAssociation = await agent.resource('users.statusHistories', firstUser.id).list({
      fields: ['id', 'userId', 'toStatus', 'reason'],
      pagination: false,
    });
    expect(firstAssociation.status).toBe(200);
    expect(firstAssociation.body.data.map(({ id }) => id)).toEqual([firstHistory.id]);
    expect(firstAssociation.body.data[0]).not.toHaveProperty('reason');

    const secondAssociation = await agent.resource('users.statusHistories', secondUser.id).list({ pagination: false });
    expect(secondAssociation.status).toBe(200);
    expect(secondAssociation.body.data.map(({ id }) => id)).toEqual([]);
  });
});
