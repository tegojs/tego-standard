import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated status history status association field scope', () => {
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
    const role = 'status-history-status-field-operator';
    const password = 'status-history-status-field-password';
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
    const target = await users.create({ values: { username: 'status-history-field-target', roles: [role] } });
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
          name: 'userStatusHistories',
          usingActionsConfig: true,
          actions: [{ name: 'list', fields: ['id', 'userId', 'fromStatusInfo', 'toStatusInfo'] }],
        },
      ],
    });
    const histories = app.db.getRepository('userStatusHistories');
    await histories.create({ values: { userId: target.id, fromStatus: 'active', toStatus: 'review' } });

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
    const directStatuses = await agent.resource('userStatuses').list({ fields: ['key'], pagination: false });
    expect(directStatuses.status).toBe(200);
    expect(directStatuses.body.data.map((status) => Object.keys(status).sort())).toEqual([['key'], ['key']]);

    const response = await agent.resource('userStatusHistories').list({
      fields: ['id', 'fromStatusInfo', 'toStatusInfo'],
      appends: ['fromStatusInfo', 'toStatusInfo'],
      pagination: false,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    for (const association of ['fromStatusInfo', 'toStatusInfo']) {
      const status = response.body.data[0][association];
      expect(Object.keys(status).sort()).toEqual(['createdAt', 'key', 'updatedAt']);
      expect(status.key).toBe(association === 'fromStatusInfo' ? 'active' : 'review');
      expect(status).not.toHaveProperty('title');
      expect(status).not.toHaveProperty('allowLogin');
      expect(status).not.toHaveProperty('description');
    }
  });
});
