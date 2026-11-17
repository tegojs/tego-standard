import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated user update status target scope', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it.each(['status', 'previousStatus'])('does not assign %s outside the operator status-list scope', async (field) => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const operatorRole = 'user-update-status-scope-operator';
    const password = 'user-update-status-scope-password';
    const roles = app.db.getRepository('roles');
    await roles.create({ values: { name: operatorRole, strategy: { actions: [] }, snippets: ['pm.users.statuses'] } });
    const statusesRepository = app.db.getRepository('userStatuses');
    await statusesRepository.create({
      values: { key: 'active', title: 'Active', allowLogin: true, isSystemDefined: true },
    });
    await statusesRepository.create({
      values: { key: 'disabled', title: 'Disabled', allowLogin: false, isSystemDefined: true },
    });
    await statusesRepository.create({
      values: { key: 'review', title: 'Review', allowLogin: true, isSystemDefined: false },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({
      values: { username: operatorRole, password, roles: [operatorRole] },
    });
    const target = await users.create({
      values: {
        username: 'user-update-status-scope-target',
        nickname: 'Original',
        roles: [operatorRole],
      },
    });
    const scopes = app.db.getRepository('dataSourcesRolesResourcesScopes');
    const statusScope = await scopes.create({
      values: {
        dataSourceKey: 'main',
        name: 'Visible statuses',
        resourceName: 'userStatuses',
        scope: { key: { $in: ['active', 'review'] } },
      },
    });
    const userScope = await scopes.create({
      values: { dataSourceKey: 'main', name: 'Editable user', resourceName: 'users', scope: { id: target.id } },
    });
    await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: operatorRole,
        name: 'userStatuses',
        usingActionsConfig: true,
        actions: [{ name: 'list', fields: ['key', 'title'], scope: { id: statusScope.id } }],
      },
    });
    const usersResource = await app.db.getRepository('dataSourcesRolesResources').create({
      values: {
        dataSourceKey: 'main',
        roleName: operatorRole,
        name: 'users',
        usingActionsConfig: true,
        actions: [
          {
            name: 'update',
            fields: ['nickname', 'status', 'previousStatus', 'statusExpireAt', 'statusReason'],
            scope: { id: userScope.id },
          },
        ],
      },
    });
    const updateAction = await app.db
      .getRepository('dataSourcesRolesResources.actions', usersResource.id)
      .findOne({ filter: { name: 'update' } });
    expect(updateAction.get('fields')).toEqual([
      'nickname',
      'previousStatus',
      'status',
      'statusExpireAt',
      'statusReason',
    ]);

    const signIn = await app.agent().post('/auth:signIn').set('X-Authenticator', 'basic').send({
      account: operator.username,
      password,
    });
    expect(signIn.status).toBe(200);
    const agent = app
      .agent()
      .set('Authorization', `Bearer ${signIn.body.data.token}`)
      .set('X-Authenticator', 'basic')
      .set('X-Role', operatorRole);
    const statuses = await agent.resource('userStatuses').list({ fields: ['key'], pagination: false });
    expect(statuses.status, JSON.stringify(statuses.body)).toBe(200);
    expect(statuses.body.data.map(({ key }) => key)).toContain('active');
    expect(statuses.body.data.map(({ key }) => key)).toContain('review');
    expect(statuses.body.data.map(({ key }) => key)).not.toContain('disabled');
    const allowed = await agent.resource('users').update({
      filterByTk: target.id,
      values: { nickname: 'Allowed edit', status: 'review', statusReason: 'visible status' },
    });
    expect(allowed.status).toBe(200);
    expect(
      await users.findOne({ filterByTk: target.id, fields: ['nickname', 'status'] }).then((row) => row.toJSON()),
    ).toEqual({
      nickname: 'Allowed edit',
      status: 'review',
    });
    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const rolesBefore = await roles.find({ raw: true, sort: ['name'] });
    const statusesBefore = await statusesRepository.find({ raw: true, sort: ['key'] });
    const histories = app.db.getRepository('userStatusHistories');
    const historiesBefore = await histories.find({ raw: true, sort: ['id'] });

    const response = await agent.resource('users').update({
      filterByTk: target.id,
      values: {
        nickname: 'Changed with hidden status',
        status: 'review',
        [field]: 'disabled',
        statusExpireAt: '2030-01-01T00:00:00.000Z',
        statusReason: 'test',
      },
    });

    expect({
      status: response.status,
      hasData: Object.hasOwn(response.body, 'data'),
      user: await users
        .findOne({ filterByTk: target.id, fields: ['nickname', 'status', 'statusReason'] })
        .then((row) => row.toJSON()),
      historyCount: await histories.count({ filter: { userId: target.id } }),
    }).toEqual({
      status: 403,
      hasData: false,
      user: { nickname: 'Allowed edit', status: 'review', statusReason: 'visible status' },
      historyCount: historiesBefore.length,
    });
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
    expect(await roles.find({ raw: true, sort: ['name'] })).toEqual(rolesBefore);
    expect(await statusesRepository.find({ raw: true, sort: ['key'] })).toEqual(statusesBefore);
    expect(await histories.find({ raw: true, sort: ['id'] })).toEqual(historiesBefore);
    expect((await users.findOne({ filterByTk: operator.id })).get('status')).toBe('active');
  });
});
