import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated user get status association field scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('limits expanded status objects to fields allowed by userStatuses:list', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const role = 'user-get-status-field-operator';
    const password = 'user-get-status-field-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: ['pm.users.statuses'] },
    });
    const statuses = app.db.getRepository('userStatuses');
    await statuses.create({
      values: { key: 'active', title: 'Active', allowLogin: true, isSystemDefined: true, description: 'Active status' },
    });
    await statuses.create({
      values: {
        key: 'review',
        title: 'Review',
        allowLogin: true,
        isSystemDefined: false,
        description: 'Review status',
      },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
    const target = await users.create({
      values: { username: 'user-get-status-field-target', roles: [role], status: 'review', previousStatus: 'active' },
    });
    await app.db.getRepository('dataSourcesRolesResources').createMany({
      records: [
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'userStatuses',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['key'] }],
        },
        {
          dataSourceKey: 'main',
          roleName: role,
          name: 'users',
          usingActionsConfig: true,
          actions: [{ name: 'get', fields: ['id', 'username', 'statusInfo', 'previousStatusInfo'] }],
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
    const response = await agent.resource('users').get({
      filterByTk: target.id,
      appends: ['statusInfo', 'previousStatusInfo'],
    });

    expect(response.status).toBe(200);
    for (const [association, key] of [
      ['statusInfo', 'review'],
      ['previousStatusInfo', 'active'],
    ] as const) {
      const status = response.body.data[association];
      expect(Object.keys(status).sort()).toEqual(['createdAt', 'key', 'updatedAt']);
      expect(status.key).toBe(key);
      expect(status).not.toHaveProperty('title');
      expect(status).not.toHaveProperty('allowLogin');
      expect(status).not.toHaveProperty('description');
    }
  });
});
