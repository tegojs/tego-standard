import { createMockServer, type MockServer } from '@tachybase/test';

describe('authenticated user status history create access', () => {
  let app: MockServer;

  afterEach(async () => {
    await app?.destroy();
  });

  it('keeps status history append-only when a role has the status-management snippet', async () => {
    app = await createMockServer({
      acl: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      plugins: ['acl', 'auth', 'users', 'data-source-manager', 'error-handler'],
    });
    const role = 'status-history-create-operator';
    const password = 'status-history-create-password';
    await app.db.getRepository('roles').create({
      values: { name: role, strategy: { actions: [] }, snippets: ['pm.users.statuses'] },
    });
    const users = app.db.getRepository('users');
    const operator = await users.create({ values: { username: role, password, roles: [role] } });
    const target = await users.create({ values: { username: 'status-history-create-target', roles: [role] } });
    const histories = app.db.getRepository('userStatusHistories');
    const existingHistory = await histories.create({
      values: {
        userId: target.id,
        fromStatus: 'active',
        toStatus: 'disabled',
        reason: 'Existing system history',
        operationType: 'manual',
      },
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
    const readable = await agent.resource('userStatusHistories').list({ fields: ['id'], pagination: false });
    expect(readable.status).toBe(200);
    expect(readable.body.data.map(({ id }) => id)).toContain(existingHistory.id);

    const usersBefore = await users.find({ raw: true, sort: ['id'] });
    const historiesBefore = await histories.find({ raw: true, sort: ['id'] });
    const response = await agent.resource('userStatusHistories').create({
      values: {
        userId: target.id,
        fromStatus: 'active',
        toStatus: 'disabled',
        reason: 'Forged history',
        operationType: 'manual',
      },
    });

    const forgedHistory = await histories.findOne({ filter: { reason: 'Forged history' }, fields: ['id'] });
    expect({
      status: response.status,
      hasData: Object.hasOwn(response.body, 'data'),
      forgedHistoryId: forgedHistory?.get('id') ?? null,
    }).toEqual({ status: 403, hasData: false, forgedHistoryId: null });
    expect(await histories.find({ raw: true, sort: ['id'] })).toEqual(historiesBefore);
    expect(await users.find({ raw: true, sort: ['id'] })).toEqual(usersBefore);
  });
});
