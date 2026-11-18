import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated status history status association read scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('does not expand from/to statuses outside the operator status-list scope', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const role = 'status-history-status-association-operator';
    const password = 'status-history-status-association-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: ['pm.users.statuses'] },
    });
    const statuses = app.db.getRepository('userStatuses');
    await statuses.create({ values: { key: 'active', title: 'Active', allowLogin: true, isSystemDefined: true } });
    await statuses.create({ values: { key: 'disabled', title: 'Disabled', allowLogin: false, isSystemDefined: true } });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
    const target = await users.create({ values: { username: 'status-history-association-target', roles: [role] } });
    const scopes = app.db.getRepository('dataSourcesRolesResourcesScopes');
    const statusScope = await scopes.create({
      values: {
        dataSourceKey: 'main',
        name: 'Active status only',
        resourceName: 'userStatuses',
        scope: { key: 'active' },
      },
    });
    const historyScope = await scopes.create({
      values: {
        dataSourceKey: 'main',
        name: 'Target user histories',
        resourceName: 'userStatusHistories',
        scope: { userId: target.id },
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
          name: 'userStatusHistories',
          usingActionsConfig: true,
          actions: [
            {
              name: 'list',
              fields: ['id', 'userId', 'fromStatus', 'toStatus', 'fromStatusInfo', 'toStatusInfo'],
              scope: { id: historyScope.id },
            },
          ],
        },
      ],
    });
    const histories = app.db.getRepository('userStatusHistories');
    const fromHidden = await histories.create({
      values: { userId: target.id, fromStatus: 'active', toStatus: 'disabled', reason: 'Hidden target status' },
    });
    const toHidden = await histories.create({
      values: { userId: target.id, fromStatus: 'disabled', toStatus: 'active', reason: 'Hidden source status' },
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

    const historiesBefore = await histories.find({ raw: true, sort: ['id'] });
    const response = await agent.resource('userStatusHistories').list({
      fields: ['id', 'fromStatusInfo', 'toStatusInfo'],
      appends: ['fromStatusInfo', 'toStatusInfo'],
      pagination: false,
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    const rows = new Map(response.body.data.map((row) => [row.id, row]));
    expect(rows.get(fromHidden.id)?.fromStatusInfo).toMatchObject({ key: 'active', title: 'Active' });
    expect(rows.get(fromHidden.id)).not.toHaveProperty('toStatusInfo');
    expect(rows.get(toHidden.id)).not.toHaveProperty('fromStatusInfo');
    expect(rows.get(toHidden.id)?.toStatusInfo).toMatchObject({ key: 'active', title: 'Active' });
    expect(await histories.find({ raw: true, sort: ['id'] })).toEqual(historiesBefore);
  });
});
